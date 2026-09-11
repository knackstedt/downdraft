// ============================================================================
// DragDropImporter — handles drag-and-drop GLB/PNG import at runtime.
// Creates blob URLs for dropped files and registers them as content.
// ============================================================================

import type { ContentEntry, ContentRegistry } from "./content-registry";

export class DragDropImporter {
  private registry: ContentRegistry;
  private dropZone: HTMLElement | null = null;
  private dragOverlay: HTMLDivElement | null = null;
  private dropCounter = 0;

  constructor(registry: ContentRegistry) {
    this.registry = registry;
  }

  /** Attach drag-drop listeners to a DOM element (typically the document body). */
  attach(target: HTMLElement | Document = document): void {
    this.dropZone = target as HTMLElement;
    target.addEventListener("dragenter", this.onDragEnter);
    target.addEventListener("dragleave", this.onDragLeave);
    target.addEventListener("dragover", this.onDragOver);
    target.addEventListener("drop", this.onDrop);
  }

  detach(): void {
    if (!this.dropZone) return;
    this.dropZone.removeEventListener("dragenter", this.onDragEnter);
    this.dropZone.removeEventListener("dragleave", this.onDragLeave);
    this.dropZone.removeEventListener("dragover", this.onDragOver);
    this.dropZone.removeEventListener("drop", this.onDrop);
    this.dropZone = null;
    this.removeOverlay();
  }

  /** Manually import a file (used by file input or programmatic import). */
  async importFile(file: File): Promise<ContentEntry | null> {
    return this.processFile(file);
  }

  /** Manually import multiple files. */
  async importFiles(files: FileList | File[]): Promise<ContentEntry[]> {
    const results: ContentEntry[] = [];
    for (const file of Array.from(files)) {
      const entry = await this.processFile(file);
      if (entry) results.push(entry);
    }
    return results;
  }

  private async processFile(file: File): Promise<ContentEntry | null> {
    const ext = file.name.split(".").pop()?.toLowerCase();
    const id = `dragdrop:${file.name}:${file.size}:${file.lastModified}`;

    if (ext === "glb" || ext === "gltf") {
      const url = URL.createObjectURL(file);
      const entry: ContentEntry = {
        id,
        name: file.name.replace(/\.[^.]+$/, ""),
        category: "prop",
        modelUri: url,
        pluginSource: "drag-drop",
        pack: "drag-drop",
        packLabel: "Drag & Drop",
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: true,
      };
      this.registry.register(entry);
      return entry;
    }

    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp") {
      const url = URL.createObjectURL(file);
      const entry: ContentEntry = {
        id,
        name: file.name.replace(/\.[^.]+$/, ""),
        category: "texture",
        thumbnailUri: url,
        pluginSource: "drag-drop",
        pack: "drag-drop",
        packLabel: "Drag & Drop",
        physics: { mass: 1.0, restitution: 0.3, friction: 0.5, gravityScale: 1.0 },
        scale: 1.0,
        paintable: true,
      };
      this.registry.register(entry);
      return entry;
    }

    console.warn(`[DragDropImporter] Unsupported file type: .${ext}`);
    return null;
  }

  // ── Drag-drop event handlers ──

  private onDragEnter = (e: Event): void => {
    e.preventDefault();
    this.dropCounter++;
    this.showOverlay();
  };

  private onDragLeave = (e: Event): void => {
    e.preventDefault();
    this.dropCounter--;
    if (this.dropCounter <= 0) {
      this.dropCounter = 0;
      this.removeOverlay();
    }
  };

  private onDragOver = (e: Event): void => {
    e.preventDefault();
    const de = e as DragEvent;
    if (de.dataTransfer) {
      de.dataTransfer.dropEffect = "copy";
    }
  };

  private onDrop = async (e: Event): Promise<void> => {
    e.preventDefault();
    this.dropCounter = 0;
    this.removeOverlay();
    const de = e as DragEvent;
    if (!de.dataTransfer?.files) return;
    await this.importFiles(de.dataTransfer.files);
  };

  private showOverlay(): void {
    if (this.dragOverlay) return;
    this.dragOverlay = document.createElement("div");
    this.dragOverlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(78, 154, 241, 0.2);
      border: 4px dashed #4e9af1;
      z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; color: #4e9af1; font-family: sans-serif;
      pointer-events: none;
    `;
    this.dragOverlay.textContent = "Drop GLB/PNG files to import";
    document.body.appendChild(this.dragOverlay);
  }

  private removeOverlay(): void {
    if (this.dragOverlay) {
      this.dragOverlay.remove();
      this.dragOverlay = null;
    }
  }
}
