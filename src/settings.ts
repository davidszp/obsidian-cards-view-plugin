import CardsViewPlugin from "./main";
import { App, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import { settings } from "./components/store";
import { BatchSummarizeModal } from "./components/BatchSummarizeModal";
import generateFilter from "./search/search";

export enum TitleDisplayMode {
  Both = "Both",
  Title = "Title",
  Filename = "Filename",
}

export enum CardDisplayMode {
  Full = "full",
  Summary = "summary",
}

export enum SummaryStyle {
  None = "none",
  Italics = "italics",
}

export interface CardsViewSettings {
  baseQuery: string;
  minCardWidth: number;
  launchOnStart: boolean;
  showDeleteButton: boolean;
  displayTitle: TitleDisplayMode;
  pinnedFiles: string[];
  savedSearch?: string[];
  // Ollama summary settings
  enableSummaries: boolean;
  ollamaEndpoint: string;
  ollamaModel: string;
  summaryWordCount: number;
  defaultDisplayMode: CardDisplayMode;
  summaryStyle: SummaryStyle;
  summaryFrontmatterKey: string;
  displayModeFrontmatterKey: string;
}

export const DEFAULT_SETTINGS: CardsViewSettings = {
  baseQuery: "",
  minCardWidth: 200,
  launchOnStart: false,
  showDeleteButton: true,
  displayTitle: TitleDisplayMode.Both,
  pinnedFiles: [],
  // Ollama defaults
  enableSummaries: false,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3.2",
  summaryWordCount: 50,
  defaultDisplayMode: CardDisplayMode.Full,
  summaryStyle: SummaryStyle.None,
  summaryFrontmatterKey: "cards-view-summary",
  displayModeFrontmatterKey: "cards-view-display",
};

export class CardsViewSettingsTab extends PluginSettingTab {
  plugin: CardsViewPlugin;

  constructor(app: App, plugin: CardsViewPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async fetchOllamaModels(dropdown: import("obsidian").DropdownComponent) {
    try {
      const endpoint = this.plugin.settings.ollamaEndpoint;
      const response = await fetch(`${endpoint}/api/tags`);
      if (!response.ok) return;

      const data = await response.json();
      const models: { name: string }[] = data.models || [];

      // Clear existing options and add fetched models
      dropdown.selectEl.empty();
      for (const model of models) {
        dropdown.addOption(model.name, model.name);
      }

      // Set current value
      dropdown.setValue(this.plugin.settings.ollamaModel);
    } catch (e) {
      console.error("[CardsView] Failed to fetch Ollama models:", e);
      // Keep the current text option as fallback
    }
  }

  async getFilteredFiles(): Promise<TFile[]> {
    const allFiles = this.app.vault.getMarkdownFiles();
    const query = this.plugin.settings.baseQuery;

    if (!query) {
      return allFiles;
    }

    try {
      const filterFn = generateFilter(query);
      const filtered: TFile[] = [];

      for (const file of allFiles) {
        const content = await file.vault.cachedRead(file);
        const match = await filterFn({
          file,
          content,
          caseSensitive: false,
        });
        if (match) {
          filtered.push(file);
        }
      }

      return filtered;
    } catch (e) {
      console.error("[CardsView] Error filtering files:", e);
      return allFiles;
    }
  }

  async updateBatchCount(statusEl: HTMLSpanElement) {
    statusEl.setText(" (counting...)");
    const files = await this.getFilteredFiles();
    const query = this.plugin.settings.baseQuery;
    if (query) {
      statusEl.setText(` — ${files.length} cards match filter "${query}"`);
    } else {
      statusEl.setText(` — ${files.length} cards (no filter set)`);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Base search query")
      .setDesc(
        "Use this for example to exclude tags, folders or keywords from the view.",
      )
      .addText((text) =>
        text
          .setPlaceholder('-path:"Folder name/" -tag:hidden')
          .setValue(this.plugin.settings.baseQuery)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              baseQuery: value,
            }));
          }),
      );

    new Setting(containerEl)
      .setName("Minimum card width")
      .setDesc("Cards will not be smaller than this width (in pixels)")
      .addText((text) =>
        text
          .setPlaceholder("200")
          .setValue(this.plugin.settings.minCardWidth.toString())
          .onChange((value) => {
            if (isNaN(parseInt(value))) {
              new Notice("Invalid number");
              return;
            }

            settings.update((s) => ({
              ...s,
              minCardWidth: parseInt(value),
            }));
          }),
      );

    new Setting(containerEl)
      .setName("Title display mode")
      .setDesc("What to display on cards starting with a # Level 1 title")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            [TitleDisplayMode.Both]: "Both title and filename",
            [TitleDisplayMode.Title]: "Title",
            [TitleDisplayMode.Filename]: "Filename",
          })
          .setValue(this.plugin.settings.displayTitle)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              displayTitle: value as TitleDisplayMode,
            }));
          }),
      );

    new Setting(containerEl)
      .setName("Show delete button")
      .setDesc(
        "Disable this option to remove the delete button, so you dont delete any note accidentally.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showDeleteButton)
          .onChange(async (value) => {
            this.plugin.settings.showDeleteButton = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Launch on start")
      .setDesc("Open the cards view when Obsidian starts")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.launchOnStart)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              launchOnStart: value,
            }));
          }),
      );

    new Setting(containerEl).setName("AI Summaries").setHeading();

    new Setting(containerEl)
      .setName("Enable AI summaries")
      .setDesc("Use Ollama to generate summaries for cards")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSummaries)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              enableSummaries: value,
            }));
          }),
      );

    new Setting(containerEl)
      .setName("Ollama endpoint")
      .setDesc("URL of your Ollama server")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.ollamaEndpoint)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              ollamaEndpoint: value,
            }));
          }),
      );

    const modelSetting = new Setting(containerEl)
      .setName("Ollama model")
      .setDesc("Model to use for generating summaries");

    // Fetch available models and create dropdown
    const modelDropdown = modelSetting.addDropdown((dropdown) => {
      dropdown
        .addOption(this.plugin.settings.ollamaModel, this.plugin.settings.ollamaModel)
        .setValue(this.plugin.settings.ollamaModel)
        .onChange((value) => {
          settings.update((s) => ({
            ...s,
            ollamaModel: value,
          }));
        });

      // Fetch models from Ollama
      this.fetchOllamaModels(dropdown);

      return dropdown;
    });

    new Setting(containerEl)
      .setName("Summary word count")
      .setDesc("Target number of words for generated summaries")
      .addText((text) =>
        text
          .setPlaceholder("50")
          .setValue(this.plugin.settings.summaryWordCount.toString())
          .onChange((value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 10) {
              new Notice("Word count must be at least 10");
              return;
            }
            settings.update((s) => ({
              ...s,
              summaryWordCount: num,
            }));
          }),
      );

    new Setting(containerEl)
      .setName("Default display mode")
      .setDesc("Show full content or summary by default")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            [CardDisplayMode.Full]: "Full content",
            [CardDisplayMode.Summary]: "Summary",
          })
          .setValue(this.plugin.settings.defaultDisplayMode)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              defaultDisplayMode: value as CardDisplayMode,
            }));
          }),
      );

    new Setting(containerEl)
      .setName("Summary style")
      .setDesc("Text style for summary display")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            [SummaryStyle.None]: "None",
            [SummaryStyle.Italics]: "Italics",
          })
          .setValue(this.plugin.settings.summaryStyle)
          .onChange((value) => {
            settings.update((s) => ({
              ...s,
              summaryStyle: value as SummaryStyle,
            }));
          }),
      );

    const batchSetting = new Setting(containerEl)
      .setName("Batch summarize")
      .setDesc("Generate summaries for all cards matching your base query filter");

    const batchStatusEl = batchSetting.descEl.createSpan({ cls: "batch-status" });

    batchSetting.addButton((btn) =>
      btn
        .setButtonText("Summarize All")
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText("Counting...");

          const files = await this.getFilteredFiles();

          btn.setDisabled(false);
          btn.setButtonText("Summarize All");

          if (files.length === 0) {
            new Notice("No files match the current filter");
            return;
          }

          new BatchSummarizeModal(
            this.app,
            files,
            this.plugin.settings,
            () => {
              // Refresh the view after batch complete
              new Notice("Batch summarization complete");
            },
          ).open();
        }),
    );

    // Show count of matching files
    this.updateBatchCount(batchStatusEl);

    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Reset settings")
      .setDesc("Reset all settings to default")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(() => {
          settings.set(DEFAULT_SETTINGS);
        }),
      );
  }
}
