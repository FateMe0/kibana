/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import uuid from 'uuid';
import {
  Embeddable,
  EmbeddableFactoryRegistry,
  EmbeddableInput,
  EmbeddableOutput,
  ErrorEmbeddable,
  EmbeddableFactory,
} from '../embeddables';
import { ViewMode } from '../types';

export interface PanelState<E extends { [key: string]: unknown } = { [key: string]: unknown }> {
  savedObjectId?: string;

  embeddableId: string;
  // The type of embeddable in this panel. Will be used to find the factory in which to
  // load the embeddable.
  type: string;

  // Stores input for this embeddable that is specific to this embeddable. Other parts of embeddable input
  // will be derived from the container's input. **Any state in here will override any state derived from
  // the container.**
  partialInput: E; // TODO: rename explicitInput vs derivedInput that is taken from the container state.
}

export interface ContainerOutput extends EmbeddableOutput {
  embeddableLoaded: { [key: string]: boolean };
}

type NonNeverPropertyNames<T> = { [K in keyof T]: T[K] extends never ? never : K }[keyof T];
type ObjectWithoutNever<T> = Pick<T, NonNeverPropertyNames<T>>;

export type EmbeddableInputMissingFromContainer<
  EI extends EmbeddableInput,
  CEI extends { [key: string]: unknown }
> = ObjectWithoutNever<{ [key in keyof EI]: CEI[key] extends EI[key] ? never : EI[key] }>;

export interface ContainerInput extends EmbeddableInput {
  hidePanelTitles?: boolean;
  panels: {
    [key: string]: PanelState;
  };
}

export abstract class Container<
  CEI extends Partial<EmbeddableInput> & { id: string } = { id: string },
  EO extends EmbeddableOutput = EmbeddableOutput,
  I extends ContainerInput = ContainerInput,
  O extends ContainerOutput = ContainerOutput
> extends Embeddable<I, O> {
  public readonly isContainer: boolean = true;
  protected readonly embeddables: {
    [key: string]: Embeddable<EmbeddableInput, EO> | ErrorEmbeddable;
  } = {};

  constructor(
    type: string,
    input: I,
    output: O,
    protected embeddableFactories: EmbeddableFactoryRegistry,
    parent?: Container
  ) {
    super(type, input, output, parent);
    this.initializeEmbeddables();
  }

  public getPartialInput(embeddableId: string) {
    return this.input.panels[embeddableId].partialInput;
  }

  public getViewMode() {
    return this.input.viewMode ? this.input.viewMode : ViewMode.EDIT;
  }

  public getHidePanelTitles() {
    return this.input.hidePanelTitles ? this.input.hidePanelTitles : false;
  }

  public updateInput(changes: Partial<I>): void {
    super.updateInput(changes);
  }

  public updateEmbeddableInput<EEI extends EmbeddableInput = EmbeddableInput>(
    id: string,
    changes: Partial<EEI>
  ) {
    this.updateInput({
      panels: {
        ...this.input.panels,
        [id]: {
          ...this.input.panels[id],
          partialInput: {
            ...this.input.panels[id].partialInput,
            ...changes,
          },
        },
      },
    } as Partial<I>);
  }

  public async addNewEmbeddable<
    EEI extends EmbeddableInput = EmbeddableInput,
    E extends Embeddable<EEI, EO> = Embeddable<EEI, EO>
  >(
    type: string,
    partialInput: Partial<EmbeddableInputMissingFromContainer<EEI, CEI>>
  ): Promise<E | ErrorEmbeddable> {
    const factory = this.embeddableFactories.getFactoryByName<EmbeddableFactory<EEI, EO, E>>(type);

    const panelState = this.createNewPanelState<EEI>(factory, partialInput);

    this.setPanelState<EEI>(panelState);
    const embeddable = await factory.create(
      this.getInputForEmbeddable<EEI>(panelState.embeddableId),
      this
    );
    this.embeddables[embeddable.id] = embeddable;

    this.updateOutput({
      ...this.output,
      embeddableLoaded: {
        [panelState.embeddableId]: true,
      },
    });
    return embeddable;
  }

  private createNewExplicitEmbeddableInput<
    EEI extends EmbeddableInput = EmbeddableInput,
    E extends Embeddable<EEI, EO> = Embeddable<EEI, EO>
  >(
    id: string,
    factory: EmbeddableFactory<EEI, EO, E>,
    partial: Partial<EmbeddableInputMissingFromContainer<EEI, CEI>> = {}
  ) {
    const inheritedInput = this.getInheritedInput(id) as { [key: string]: unknown };
    const defaults = factory.getDefaultInputParameters() as { [key: string]: unknown };

    // Container input overrides defaults.
    const defaultExplicitInput: { [key: string]: unknown } = partial;
    Object.keys(defaults).forEach(key => {
      if (inheritedInput[key] === undefined && defaultExplicitInput[key] === undefined) {
        defaultExplicitInput[key] = defaults[key];
      }
    });
    return defaultExplicitInput;
  }

  public async addSavedObjectEmbeddable<
    EEI extends EmbeddableInput = EmbeddableInput,
    E extends Embeddable<EEI, EO> = Embeddable<EEI, EO>
  >(type: string, savedObjectId: string): Promise<E | ErrorEmbeddable> {
    const factory = this.embeddableFactories.getFactoryByName<EmbeddableFactory<EEI, EO, E>>(type);
    const panelState = this.createNewPanelState<EEI>(factory);
    panelState.savedObjectId = savedObjectId;
    this.setPanelState<EEI>(panelState);
    const embeddable = await factory.createFromSavedObject(
      savedObjectId,
      this.getInputForEmbeddable<EEI>(panelState.embeddableId),
      this
    );
    this.embeddables[embeddable.id] = embeddable;

    this.updateOutput({
      ...this.output,
      embeddableLoaded: {
        [panelState.embeddableId]: true,
      },
    });
    return embeddable;
  }

  public removeEmbeddable(embeddableId: string) {
    const embeddable = this.getEmbeddable(embeddableId);
    embeddable.destroy();
    delete this.embeddables[embeddableId];

    const changedInput: { panels: { [key: string]: PanelState } } = {
      panels: {},
    };
    Object.values(this.input.panels).forEach(panel => {
      if (panel.embeddableId !== embeddableId) {
        changedInput.panels[panel.embeddableId] = panel;
      }
    });
    this.updateInput({ ...changedInput } as Partial<I>);
  }

  public getEmbeddable<E extends Embeddable<EmbeddableInput, EO> = Embeddable<EmbeddableInput, EO>>(
    id: string
  ): E {
    return this.embeddables[id] as E;
  }

  private setPanelState<EEI extends EmbeddableInput = EmbeddableInput>(
    panelState: PanelState<EmbeddableInputMissingFromContainer<EEI, CEI>>
  ) {
    this.updateInput({
      ...this.input,
      panels: {
        ...this.input.panels,
        [panelState.embeddableId]: panelState,
      },
    });
  }

  private updatePanelState<EEI extends EmbeddableInput = EmbeddableInput>(
    panelState: PanelState<EmbeddableInputMissingFromContainer<EEI, CEI>>
  ) {
    this.updateInput({
      panels: {
        ...this.input.panels,
        [panelState.embeddableId]: {
          ...this.input.panels[panelState.embeddableId],
          ...panelState,
        },
      },
    } as Partial<I>);
  }

  protected async loadEmbeddable<EEI extends EmbeddableInput = EmbeddableInput>(
    panelState: PanelState<EmbeddableInputMissingFromContainer<EEI, CEI>>
  ) {
    if (this.input.panels[panelState.embeddableId] === undefined) {
      throw new Error(`Panel with id ${panelState.embeddableId} does not exist in this container`);
    }

    const factory = this.embeddableFactories.getFactoryByName<EmbeddableFactory<EEI, EO>>(
      panelState.type
    );

    const embeddable = panelState.savedObjectId
      ? await factory.createFromSavedObject(
          panelState.savedObjectId,
          this.getInputForEmbeddable<EEI>(panelState.embeddableId),
          this
        )
      : await factory.create(this.getInputForEmbeddable<EEI>(panelState.embeddableId), this);
    this.embeddables[embeddable.id] = embeddable;
    this.updatePanelState<EEI>(panelState);

    this.updateOutput({
      embeddableLoaded: {
        [panelState.embeddableId]: true,
      },
    } as Partial<O>);
  }

  protected createNewPanelState<EEI extends EmbeddableInput = EmbeddableInput>(
    factory: EmbeddableFactory<EEI, EO>,
    partial: Partial<EmbeddableInputMissingFromContainer<EEI, CEI>> = {}
  ): PanelState<EmbeddableInputMissingFromContainer<EEI, CEI>> {
    const embeddableId = uuid.v4();
    const defaultExplicitInput = this.createNewExplicitEmbeddableInput<EEI>(
      embeddableId,
      factory,
      partial
    ) as EmbeddableInputMissingFromContainer<EEI, CEI>;

    return {
      type: factory.name,
      embeddableId,
      partialInput: defaultExplicitInput,
    };
  }

  protected getPanelState<EI>(embeddableId: string) {
    const panelState: PanelState = this.input.panels[embeddableId];
    return panelState as PanelState<EI>;
  }

  protected abstract getInheritedInput(id: string): CEI;

  public getExplicitEmbeddableInput(id: string) {
    return this.getPanelStateForEmbeddable(id).partialInput;
  }

  public getInputForEmbeddable<EEI extends EmbeddableInput = EmbeddableInput>(
    embeddableId: string
  ): EEI {
    const containerInput: CEI = this.getInheritedInput(embeddableId);
    const panelState = this.getPanelState<EmbeddableInputMissingFromContainer<EEI, CEI>>(
      embeddableId
    );

    return ({
      ...containerInput,
      ...panelState.partialInput,
      // Typescript has difficulties with inferring this type but it is accurate with all
      // tests I tried. Could probably be revisted with future releases of TS to see if
      // it can accurately infer the type.
    } as unknown) as EEI;
  }

  public getPanelStateForEmbeddable<EEI extends EmbeddableInput = EmbeddableInput>(
    id: string
  ): PanelState {
    return this.input.panels[id];
  }

  private async initializeEmbeddables() {
    const promises = Object.values(this.input.panels).map(panel =>
      this.loadEmbeddable<EmbeddableInput>(panel as PanelState<
        EmbeddableInputMissingFromContainer<EmbeddableInput, CEI>
      >)
    );
    await Promise.all(promises);
  }
}
