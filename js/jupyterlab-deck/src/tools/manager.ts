import { EMOJI, IDeckManager, IToolManager } from '../tokens';

import { DesignTools } from './design';
import { DeckRemote } from './remote';

/**
 * Handle composable design and navigation tools
 */
export class ToolManager implements IToolManager {
  protected _remote: DeckRemote | null = null;
  protected _design: DesignTools | null = null;

  protected _designTools = new Map<string, IToolManager.IToolOptions>();
  protected _remoteTools = new Map<string, IToolManager.IToolOptions>();

  protected _decks: IDeckManager;
  constructor(options: ToolManager.IOptions) {
    this._decks = options.decks;
  }

  public get decks(): IDeckManager {
    return this._decks;
  }

  public async stop(): Promise<void> {
    const { _remote, _design } = this;
    if (_remote) {
      _remote.dispose();
      this._remote = null;
    }
    if (_design) {
      _design.dispose();
      this._design = null;
    }
  }

  public async start(): Promise<void> {
    this._remote = new DeckRemote({ manager: this._decks });
    this._design = new DesignTools({ manager: this._decks });
  }

  public addTool(
    area: IToolManager.TToolArea,
    options: IToolManager.IToolOptions
  ): void {
    const { id } = options;
    const toolset = area == 'design' ? this._designTools : this._remoteTools;
    if (toolset.has(id)) {
      console.warn(`${EMOJI} ${area} tools already has ${options.id}`);
      return;
    }
    toolset.set(id, options);
  }
}

export namespace ToolManager {
  export interface IOptions {
    decks: IDeckManager;
  }
}
