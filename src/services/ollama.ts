import { App, Notice, TFile } from "obsidian";
import type { CardsViewSettings } from "../settings";

export interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
}

export interface SummaryResult {
  summary: string;
  wordCount: number;
  model: string;
}

/**
 * Service for generating summaries using Ollama
 */
export class OllamaService {
  private app: App;
  private settings: CardsViewSettings;

  constructor(app: App, settings: CardsViewSettings) {
    this.app = app;
    this.settings = settings;
  }

  updateSettings(settings: CardsViewSettings) {
    this.settings = settings;
  }

  /**
   * Check if Ollama is available at the configured endpoint
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.settings.ollamaEndpoint}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get list of available models
   */
  async getModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.settings.ollamaEndpoint}/api/tags`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.models?.map((m: { name: string }) => m.name) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Generate a summary for the given content
   */
  async generateSummary(content: string): Promise<SummaryResult | null> {
    const { ollamaEndpoint, ollamaModel, summaryWordCount } = this.settings;

    // Truncate very long content to avoid overwhelming the model
    const maxChars = 8000;
    const truncatedContent = content.length > maxChars
      ? content.slice(0, maxChars) + "\n\n[Content truncated...]"
      : content;

    const prompt = `Summarize the following text in approximately ${summaryWordCount} words.
Be concise and capture the main points. Do not include any preamble or explanation, just provide the summary directly.

Text to summarize:
${truncatedContent}

Summary:`;

    console.log("[CardsView] Generating summary with model:", ollamaModel);

    try {
      const response = await fetch(`${ollamaEndpoint}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: summaryWordCount * 3, // Allow more buffer
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[CardsView] Ollama request failed:", response.status, errorText);
        throw new Error(`Ollama error: ${response.status} - ${errorText}`);
      }

      const data: OllamaResponse = await response.json();
      console.log("[CardsView] Ollama response:", data);

      const summary = data.response.trim();
      const wordCount = summary.split(/\s+/).length;

      return {
        summary,
        wordCount,
        model: ollamaModel,
      };
    } catch (e) {
      console.error("[CardsView] Error generating summary:", e);
      throw e; // Re-throw so caller can handle
    }
  }

  /**
   * Generate and save summary for a file
   */
  async summarizeFile(file: TFile): Promise<SummaryResult | null> {
    const content = await file.vault.cachedRead(file);

    // Strip frontmatter for summarization
    const contentWithoutFrontmatter = content.replace(/^---[\s\S]*?---\n?/, "");

    if (contentWithoutFrontmatter.trim().length < 50) {
      // Too short to summarize
      return null;
    }

    const result = await this.generateSummary(contentWithoutFrontmatter);
    if (!result) return null;

    // Save summary to frontmatter
    await this.saveSummaryToFrontmatter(file, result.summary);

    return result;
  }

  /**
   * Save summary to file's frontmatter
   */
  async saveSummaryToFrontmatter(file: TFile, summary: string): Promise<void> {
    const { summaryFrontmatterKey } = this.settings;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[summaryFrontmatterKey] = summary;
    });
  }

  /**
   * Get existing summary from file's frontmatter
   */
  async getSummaryFromFrontmatter(file: TFile): Promise<string | null> {
    const { summaryFrontmatterKey } = this.settings;
    let summary: string | null = null;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (fm[summaryFrontmatterKey]) {
        summary = fm[summaryFrontmatterKey];
      }
    });

    return summary;
  }

  /**
   * Get display mode preference from file's frontmatter
   */
  async getDisplayModeFromFrontmatter(
    file: TFile,
  ): Promise<"full" | "summary" | null> {
    const { displayModeFrontmatterKey } = this.settings;
    let mode: "full" | "summary" | null = null;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (fm[displayModeFrontmatterKey] === "full" || fm[displayModeFrontmatterKey] === "summary") {
        mode = fm[displayModeFrontmatterKey];
      }
    });

    return mode;
  }

  /**
   * Set display mode preference in file's frontmatter
   */
  async setDisplayModeInFrontmatter(
    file: TFile,
    mode: "full" | "summary",
  ): Promise<void> {
    const { displayModeFrontmatterKey } = this.settings;

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[displayModeFrontmatterKey] = mode;
    });
  }

  /**
   * Batch generate summaries for multiple files
   */
  async batchSummarize(
    files: TFile[],
    onProgress?: (completed: number, total: number) => void,
  ): Promise<Map<string, SummaryResult>> {
    const results = new Map<string, SummaryResult>();

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Check if summary already exists
      const existing = await this.getSummaryFromFrontmatter(file);
      if (existing) {
        results.set(file.path, {
          summary: existing,
          wordCount: existing.split(/\s+/).length,
          model: "cached",
        });
      } else {
        const result = await this.summarizeFile(file);
        if (result) {
          results.set(file.path, result);
        }
      }

      onProgress?.(i + 1, files.length);
    }

    return results;
  }
}

// Singleton instance
let ollamaServiceInstance: OllamaService | null = null;

export function getOllamaService(app: App, settings: CardsViewSettings): OllamaService {
  if (!ollamaServiceInstance) {
    ollamaServiceInstance = new OllamaService(app, settings);
  } else {
    ollamaServiceInstance.updateSettings(settings);
  }
  return ollamaServiceInstance;
}
