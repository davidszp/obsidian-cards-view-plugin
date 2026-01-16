import { App, Modal, Setting, TFile } from "obsidian";
import { getOllamaService } from "../services/ollama";
import type { CardsViewSettings } from "../settings";

export class BatchSummarizeModal extends Modal {
  private files: TFile[];
  private settings: CardsViewSettings;
  private onComplete: () => void;
  private isRunning = false;
  private shouldCancel = false;

  constructor(
    app: App,
    files: TFile[],
    settings: CardsViewSettings,
    onComplete: () => void,
  ) {
    super(app);
    this.files = files;
    this.settings = settings;
    this.onComplete = onComplete;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cards-view-batch-modal");

    this.showConfirmation();
  }

  private showConfirmation() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Batch Summarize" });

    contentEl.createEl("p", {
      text: `Are you sure you want to generate summaries for ${this.files.length} cards using ${this.settings.ollamaModel}?`,
    });

    contentEl.createEl("p", {
      text: "This may take a while depending on the number of cards and your hardware.",
      cls: "mod-warning",
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Cancel")
          .onClick(() => this.close()),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Start")
          .setCta()
          .onClick(() => this.startBatch()),
      );
  }

  private async startBatch() {
    const { contentEl } = this;
    contentEl.empty();
    this.isRunning = true;
    this.shouldCancel = false;

    contentEl.createEl("h2", { text: "Generating Summaries..." });

    const statusEl = contentEl.createEl("p", {
      text: `Processing 0 / ${this.files.length}`,
    });

    const progressContainer = contentEl.createDiv({ cls: "progress-container" });
    const progressBar = progressContainer.createDiv({ cls: "progress-bar" });
    progressBar.style.width = "0%";

    const currentFileEl = contentEl.createEl("p", {
      text: "",
      cls: "current-file",
    });

    const statsEl = contentEl.createEl("p", {
      text: "",
      cls: "batch-stats",
    });

    new Setting(contentEl).addButton((btn) =>
      btn.setButtonText("Cancel").onClick(() => {
        this.shouldCancel = true;
        btn.setDisabled(true);
        btn.setButtonText("Cancelling...");
      }),
    );

    const ollama = getOllamaService(this.app, this.settings);
    let completed = 0;
    let skipped = 0;
    let failed = 0;

    for (const file of this.files) {
      if (this.shouldCancel) break;

      currentFileEl.setText(`Current: ${file.basename}`);

      // Check if summary already exists
      const existing = await ollama.getSummaryFromFrontmatter(file);
      if (existing) {
        skipped++;
      } else {
        try {
          await ollama.summarizeFile(file);
        } catch (e) {
          console.error("[CardsView] Batch summarize error:", file.path, e);
          failed++;
        }
      }

      completed++;
      const progress = (completed / this.files.length) * 100;
      progressBar.style.width = `${progress}%`;
      statusEl.setText(`Processing ${completed} / ${this.files.length}`);
      statsEl.setText(
        `Generated: ${completed - skipped - failed} | Skipped (existing): ${skipped} | Failed: ${failed}`,
      );
    }

    this.isRunning = false;
    this.showComplete(completed, skipped, failed);
  }

  private showComplete(completed: number, skipped: number, failed: number) {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", {
      text: this.shouldCancel ? "Cancelled" : "Complete",
    });

    contentEl.createEl("p", {
      text: `Processed: ${completed} / ${this.files.length}`,
    });

    contentEl.createEl("p", {
      text: `Generated: ${completed - skipped - failed} | Skipped: ${skipped} | Failed: ${failed}`,
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Close")
        .setCta()
        .onClick(() => {
          this.close();
          this.onComplete();
        }),
    );
  }

  onClose() {
    if (this.isRunning) {
      this.shouldCancel = true;
    }
    this.contentEl.empty();
  }
}
