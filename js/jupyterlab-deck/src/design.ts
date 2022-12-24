import { CommandRegistry } from '@lumino/commands';
import { Signal, ISignal } from '@lumino/signaling';

import { ICONS } from './icons';
import { CommandIds, EMOJI, IDeckManager, IDesignManager } from './tokens';
import type { Layover } from './tools/layover';

export class DesignManager implements IDesignManager {
  protected _tools = new Map<string, IDesignManager.IToolOptions>();
  protected _deckManager: IDeckManager;
  protected _layover: Layover | null = null;
  protected _layoverChanged = new Signal<IDesignManager, void>(this);
  protected _commands: CommandRegistry;

  constructor(options: DesignManager.IOptions) {
    this._deckManager = options.deckManager;
    this._commands = options.commands;
    this._addCommands();
  }

  __(msgid: string, ...args: string[]) {
    return this._deckManager.__(msgid, ...args);
  }

  protected _addCommands() {
    this._commands.addCommand(CommandIds.showLayover, {
      icon: ICONS.transformStart,
      label: this.__('Show Slide Layout'),
      execute: () => this.showLayover(),
    });

    this._commands.addCommand(CommandIds.hideLayover, {
      icon: ICONS.transformStop,
      label: this.__('Hide Slide Layout'),
      execute: () => this.hideLayover(),
    });
  }

  get deckManager(): IDeckManager {
    return this._deckManager;
  }

  addTool(options: IDesignManager.IToolOptions): void {
    if (this._tools.has(options.id)) {
      console.warn(`${EMOJI} design tool already registered: ${options.id}`);
      return;
    }
    this._tools.set(options.id, options);
  }

  get layover(): Layover | null {
    return this._layover;
  }

  public get layoverChanged(): ISignal<IDesignManager, void> {
    return this._layoverChanged;
  }

  public async showLayover() {
    if (!this._layover) {
      this._layover = new (await import('./tools/layover')).Layover({
        manager: this._deckManager,
      });
      this._layoverChanged.emit(void 0);
    }
    await this._deckManager.start(true);
  }

  public async hideLayover() {
    if (this._layover) {
      this._layover.dispose();
      this._layover = null;
      this._layoverChanged.emit(void 0);
    }
  }
}

export namespace DesignManager {
  export interface IOptions {
    deckManager: IDeckManager;
    commands: CommandRegistry;
  }
}
