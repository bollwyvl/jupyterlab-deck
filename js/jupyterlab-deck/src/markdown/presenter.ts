import { MainAreaWidget } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { FileEditorPanel, FileEditor } from '@jupyterlab/fileeditor';
import { MarkdownDocument, MarkdownViewer } from '@jupyterlab/markdownviewer';
import { CommandRegistry } from '@lumino/commands';
import { JSONExt, PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { Widget } from '@lumino/widgets';

const { emptyObject } = JSONExt;

import {
  IDeckManager,
  IPresenter,
  TCanGoDirection,
  TDirection,
  CSS,
  DIRECTION,
  CommandIds,
  DIRECTION_KEYS,
  COMPOUND_KEYS,
  MARKDOWN_MIMETYPES,
  MARKDOWN_PREVIEW_FACTORY,
} from '../tokens';

export class SimpleMarkdownPresenter
  implements IPresenter<MarkdownDocument | FileEditorPanel>
{
  protected _activeChanged = new Signal<
    IPresenter<MarkdownDocument | FileEditorPanel>,
    void
  >(this);

  public readonly id = 'simple-markdown';
  public readonly rank = 100;
  public readonly capabilities = {};
  protected _manager: IDeckManager;
  protected _docManager: IDocumentManager;
  protected _previousActiveCellIndex: number = -1;
  protected _commands: CommandRegistry;
  protected _activeSlide = new WeakMap<MarkdownDocument, number>();
  protected _lastSlide = new WeakMap<MarkdownDocument, number>();
  protected _stylesheets = new WeakMap<MarkdownDocument, HTMLStyleElement>();
  protected _activateWidget: SimpleMarkdownPresenter.IWidgetActivator;
  protected _extents = new WeakMap<
    MarkdownDocument,
    SimpleMarkdownPresenter.TExtentMap
  >();
  protected _previewRequests = new WeakMap<
    FileEditorPanel,
    PromiseDelegate<MarkdownDocument>
  >();

  constructor(options: SimpleMarkdownPresenter.IOptions) {
    this._manager = options.manager;
    this._commands = options.commands;
    this._docManager = options.docManager;
    this._activateWidget = options.activateWidget;

    this._addKeyBindings();
    this._addWindowListeners();
  }

  public accepts(widget: Widget): MarkdownDocument | FileEditorPanel | null {
    if (widget instanceof MarkdownDocument) {
      return widget;
    }
    if (
      widget instanceof MainAreaWidget &&
      widget.content instanceof FileEditor &&
      MARKDOWN_MIMETYPES.includes(widget.content.model.mimeType)
    ) {
      return widget;
    }
    return null;
  }

  public async stop(panel: MarkdownDocument | FileEditorPanel): Promise<void> {
    const preview = await this._ensurePreviewPanel(panel);
    this._removeStyle(preview);
    if (!(panel instanceof MarkdownDocument)) {
      this._previewRequests.delete(panel);
    }
    return;
  }

  public async start(panel: MarkdownDocument | FileEditorPanel): Promise<void> {
    const preview = await this._ensurePreviewPanel(panel);
    if (preview != panel) {
      this._activateWidget(preview);
    }
    await preview.content.ready;
    preview.content.rendered.connect(this._onRendered, this);
    const activeSlide = this._activeSlide.get(preview) || 1;
    this._updateSheet(preview, activeSlide);
    return;
  }

  public async go(
    panel: MarkdownDocument | FileEditorPanel,
    direction: TDirection,
    alternate?: TDirection,
  ): Promise<void> {
    let preview = await this._ensurePreviewPanel(panel);
    await preview.content.ready;

    let index = this._activeSlide.get(preview) || 1;
    const extents = await this._getExtents(preview);
    const activeExtent = extents.get(index);
    if (activeExtent) {
      const fromExtent = activeExtent && activeExtent[direction];
      const fromExtentAlternate = alternate && activeExtent && activeExtent[alternate];
      if (fromExtent) {
        index = fromExtent;
      } else if (fromExtentAlternate) {
        index = fromExtentAlternate;
      }
      this._updateSheet(preview, index);
      return;
    }
    let lastSlide = this._lastSlide.get(preview) || -1;
    if (direction == 'forward' || alternate == 'forward') {
      index++;
    } else if (direction == 'back' || alternate == 'back') {
      index--;
    }
    index = index < 1 ? 1 : index > lastSlide ? lastSlide : index;
    this._updateSheet(preview, index);
  }

  public async canGo(
    panel: MarkdownDocument | FileEditorPanel,
  ): Promise<Partial<TCanGoDirection>> {
    let preview = await this._ensurePreviewPanel(panel);

    let index = this._activeSlide.get(preview) || 1;

    const extents = await this._getExtents(preview);
    const activeExtent = extents.get(index);
    if (activeExtent) {
      const { up, down, forward, back } = activeExtent;
      return {
        up: up != null,
        down: down != null,
        forward: forward != null,
        back: back != null,
      };
    }

    // TODO: someplace better
    let hrCount = preview.content.renderer.node.querySelectorAll('hr').length;
    this._lastSlide.set(preview, hrCount);
    return {
      forward: index < hrCount,
      back: index > 1,
    };
  }

  public async style(panel: MarkdownDocument | FileEditorPanel): Promise<void> {
    const { _manager } = this;
    panel = await this._ensurePreviewPanel(panel);
    panel.addClass(CSS.deck);
    _manager.cacheStyle(panel.node, panel.content.node, panel.content.renderer.node);
  }

  public get activeChanged(): ISignal<
    IPresenter<MarkdownDocument | FileEditorPanel>,
    void
  > {
    return this._activeChanged;
  }

  protected _onRendered(viewer: MarkdownViewer) {
    const { parent } = viewer;
    if (parent instanceof MarkdownDocument) {
      this._extents.delete(parent);
    }
  }

  protected _newExtent(
    index: number,
    extent?: Partial<SimpleMarkdownPresenter.IExtent>,
  ): SimpleMarkdownPresenter.IExtent {
    return {
      index,
      subslides: [],
      up: null,
      down: null,
      forward: null,
      back: null,
      ...(extent || emptyObject),
    };
  }

  protected async _getExtents(
    preview: MarkdownDocument,
  ): Promise<SimpleMarkdownPresenter.TExtentMap> {
    const extents: SimpleMarkdownPresenter.TExtentMap = new Map();
    const cachedExtents = this._extents.get(preview);
    if (cachedExtents && cachedExtents.size) {
      return cachedExtents;
    }
    let index = 0;
    let lastSlide: SimpleMarkdownPresenter.IExtent | null = null;
    let lastSubslide: SimpleMarkdownPresenter.IExtent | null = null;
    let allHrs = [
      ...preview.content.node.querySelectorAll('.jp-RenderedMarkdown > hr'),
    ];

    while (index < allHrs.length) {
      let hr = allHrs[index];
      const isSubslide = hr.nextElementSibling?.tagName === 'HR';
      if (isSubslide) {
        index++;
      }

      let extent = this._newExtent(index);

      if (isSubslide) {
        // this is a subslide
        index++;
        if (lastSlide == null) {
          lastSlide = extent;
          continue;
        }

        extent.subslides.push(extent);

        if (lastSubslide == null) {
          lastSlide.down = extent.index;
          extent.up = lastSlide.index;
        } else {
          lastSubslide.down = extent.index;
          extent.up = lastSubslide.index;
        }
        lastSubslide = extent;
        continue;
      } else {
        // this is a slide
        if (lastSlide) {
          lastSlide.forward = index;
          for (const subslide of lastSlide.subslides) {
            subslide.forward = index;
          }
          extent.back = lastSlide.index;
        }

        lastSlide = extent;
        lastSubslide = null;
      }

      extents.set(index, extent);
      index++;
    }

    this._extents.set(preview, extents);
    return extents;
  }

  /** overload the stock editor keyboard shortcuts */
  protected _addKeyBindings() {
    for (const direction of Object.values(DIRECTION)) {
      this._commands.addKeyBinding({
        command: CommandIds[direction],
        keys: DIRECTION_KEYS[direction],
        selector: `.${CSS.deck} .${CSS.markdownViewer}`,
      });
    }
    for (const [directions, keys] of COMPOUND_KEYS.entries()) {
      const [direction, alternate] = directions;
      this._commands.addKeyBinding({
        command: CommandIds.go,
        args: { direction, alternate },
        keys,
        selector: `.${CSS.deck} .${CSS.markdownViewer}`,
      });
    }
  }

  protected _addWindowListeners() {
    window.addEventListener('hashchange', this._onHashChange);
  }

  protected _onHashChange = async (event: HashChangeEvent) => {
    const { activeWidget } = this._manager;
    let panel = activeWidget && this.accepts(activeWidget);
    /* istanbul ignore if */
    if (!panel) {
      return;
    }
    panel = await this._ensurePreviewPanel(panel);
    const url = new URL(event.newURL);
    const { hash } = url || '#';
    /* istanbul ignore if */
    if (hash === '#') {
      return;
    }
    await this._activateByAnchor(panel, hash);
  };

  protected async _activateByAnchor(panel: MarkdownDocument, fragment: string) {
    panel = await this._ensurePreviewPanel(panel);

    const anchored = document.getElementById(fragment.slice(1));

    /* istanbul ignore if */
    if (!anchored || !panel.node.contains(anchored)) {
      return;
    }
    let index = 0;
    for (const child of panel.content.renderer.node.children) {
      if (child.tagName === 'HR') {
        index += 1;
        continue;
      }
      if (child === anchored) {
        this._updateSheet(panel, index);
        break;
      }
    }
  }

  protected async _ensurePreviewPanel(
    panel: MarkdownDocument | FileEditorPanel,
  ): Promise<MarkdownDocument> {
    if (panel instanceof MarkdownDocument) {
      return panel;
    }
    let promiseDelegate = this._previewRequests.get(panel);
    if (promiseDelegate) {
      return await promiseDelegate.promise;
    }
    promiseDelegate = new PromiseDelegate();
    this._previewRequests.set(panel, promiseDelegate);
    let preview = this._getPreviewPanel(panel);
    if (preview == null) {
      await this._commands.execute('fileeditor:markdown-preview');
      preview = this._getPreviewPanel(panel);
      await preview.revealed;
      promiseDelegate.resolve(preview);
    }
    return preview;
  }

  protected _getPreviewPanel(panel: MarkdownDocument | FileEditorPanel) {
    /* istanbul ignore if */
    if (panel instanceof MarkdownDocument) {
      return panel;
    }
    return this._docManager.findWidget(
      panel.content.context.path,
      MARKDOWN_PREVIEW_FACTORY,
    ) as MarkdownDocument;
  }

  protected _updateSheet(panel: MarkdownDocument, index: number) {
    let sheet = this._stylesheets.get(panel);
    if (sheet == null) {
      sheet = document.createElement('style');
      sheet.className = CSS.sheet;
      this._stylesheets.set(panel, sheet);
      document.body.appendChild(sheet);
    }
    sheet.textContent = `
    #${panel.id} > .${CSS.markdownViewer} .${
      CSS.renderedMarkdown
    } > hr:nth-of-type(${index}) ~ :not(hr:nth-of-type(${index + 1}) ~ *):not(hr) {
      display: block;
    }`;
    this._activeSlide.set(panel, index);
  }

  protected _removeStyle(panel: MarkdownDocument) {
    /* istanbul ignore if */
    if (panel.isDisposed) {
      return;
    }
    const { _manager } = this;
    panel.removeClass(CSS.deck);
    _manager.uncacheStyle(panel.content.node, panel.node, panel.content.renderer.node);
  }
}

export namespace SimpleMarkdownPresenter {
  export interface IOptions {
    manager: IDeckManager;
    commands: CommandRegistry;
    docManager: IDocumentManager;
    activateWidget: IWidgetActivator;
  }

  export interface IWidgetActivator {
    (widget: Widget): void;
  }

  export interface IExtent {
    index: number;
    subslides: IExtent[];
    up: number | null;
    down: number | null;
    forward: number | null;
    back: number | null;
  }

  export type TExtentMap = Map<number, SimpleMarkdownPresenter.IExtent>;
}
