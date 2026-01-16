<script lang="ts">
  import {
    type MarkdownPostProcessorContext,
    MarkdownPreviewRenderer,
    MarkdownRenderer,
    Menu,
    Notice,
    setIcon,
    TFile,
  } from "obsidian";
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { app, view, settings } from "./store";
  import { TitleDisplayMode, CardDisplayMode, SummaryStyle } from "../settings";
  import { extractPreviewContent } from "../utils/previewContent";
  import { getOllamaService } from "../services/ollama";

  interface Props {
    file: TFile;
    updateLayoutNextTick: () => Promise<void>;
  }

  let { file, updateLayoutNextTick }: Props = $props();
  let contentDiv: HTMLElement;
  let pinned: boolean = $derived($settings.pinnedFiles.includes(file.path));
  // This will depend both on the settings and the content of the file
  let displayFilename: boolean = $state(true);
  let translateTransition: boolean = $state(false);

  // Summary-related state
  let summaryText: string | null = $state(null);
  let displayMode: "full" | "summary" = $state("full");
  let isGeneratingSummary: boolean = $state(false);

  function postProcessor(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
  ) {
    if (context.sourcePath !== file.path) {
      // Very important to check if the sourcePath is the same as the file path
      // Otherwise, the post processor will be applied to all files
      return;
    }

    if (
      $settings.displayTitle != TitleDisplayMode.Both &&
      element.children.length > 0 &&
      element.children[0].tagName === "H1" &&
      element.children[0].textContent
    ) {
      if ($settings.displayTitle == TitleDisplayMode.Title) {
        displayFilename = false;
      } else if ($settings.displayTitle == TitleDisplayMode.Filename) {
        element.children[0].remove();
      }
    }

    if (element.children.length === 0) {
      return;
    }

    // Add shadow to blocks of embed notes (we take all .internal-embed,
    // including images, because we can't differentiate them at that time,
    // but CSS will only apply to embed notes)
    for (let i = 0; i < element.children.length; i++) {
      if (
        element.children[i].getElementsByClassName("internal-embed").length ||
        element.children[i].className.includes("block-language-dataview")
      ) {
        element.style.removeProperty("overflow-x");
        element.children[i].appendChild(
          document.createElement("div"),
        ).className = "embed-shadow";
      }
    }
  }

  const loadSummaryData = async () => {
    if (!$settings.enableSummaries) {
      displayMode = "full";
      return;
    }

    const ollama = getOllamaService($app, $settings);

    // Check frontmatter for display preference
    const fmDisplayMode = await ollama.getDisplayModeFromFrontmatter(file);
    displayMode = fmDisplayMode ?? $settings.defaultDisplayMode;

    // Load existing summary
    summaryText = await ollama.getSummaryFromFrontmatter(file);
  };

  const generateSummary = async (e: Event) => {
    e.stopPropagation();
    e.preventDefault();

    if (!$settings.enableSummaries || isGeneratingSummary) return;

    isGeneratingSummary = true;
    const ollama = getOllamaService($app, $settings);

    // Check if Ollama is available
    const available = await ollama.isAvailable();
    if (!available) {
      new Notice(`Cannot connect to Ollama at ${$settings.ollamaEndpoint}`);
      isGeneratingSummary = false;
      return;
    }

    try {
      const result = await ollama.summarizeFile(file);
      if (result) {
        summaryText = result.summary;
        new Notice(`Summary generated (${result.wordCount} words)`);
      } else {
        new Notice("Failed to generate summary");
      }
    } catch (err) {
      console.error("[CardsView] Summary error:", err);
      new Notice(`Summary error: ${err}`);
    }

    isGeneratingSummary = false;
    await updateLayoutNextTick();
  };

  const toggleDisplayMode = async (e: Event) => {
    e.stopPropagation();
    e.preventDefault();

    const newMode = displayMode === "full" ? "summary" : "full";
    displayMode = newMode;

    // Save preference to frontmatter
    const ollama = getOllamaService($app, $settings);
    await ollama.setDisplayModeInFrontmatter(file, newMode);
    await updateLayoutNextTick();
  };

  const showSummaryContextMenu = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle("Delete summary")
        .setIcon("trash")
        .onClick(async () => {
          // Remove summary from frontmatter
          const { summaryFrontmatterKey } = $settings;
          await $app.fileManager.processFrontMatter(file, (fm) => {
            delete fm[summaryFrontmatterKey];
          });

          summaryText = null;
          displayMode = "full";
          new Notice("Summary deleted");
          await updateLayoutNextTick();
        });
    });

    menu.addItem((item) => {
      item
        .setTitle("Regenerate summary")
        .setIcon("refresh-cw")
        .onClick(async () => {
          // Delete first, then regenerate
          const { summaryFrontmatterKey } = $settings;
          await $app.fileManager.processFrontMatter(file, (fm) => {
            delete fm[summaryFrontmatterKey];
          });

          summaryText = null;
          await generateSummary(e);
        });
    });

    menu.showAtMouseEvent(e);
  };

  const renderFile = async (el: HTMLElement): Promise<void> => {
    // Load summary data first
    await loadSummaryData();

    const fullContent = await file.vault.cachedRead(file);
    const previewContent = extractPreviewContent(fullContent);
    MarkdownPreviewRenderer.registerPostProcessor(postProcessor);
    await MarkdownRenderer.render($app, previewContent, el, file.path, $view);
    el.style.removeProperty("overflow-x");
    MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor);
  };

  const togglePin = async (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    $settings.pinnedFiles = pinned
      ? $settings.pinnedFiles.filter((f) => f !== file.path)
      : [...$settings.pinnedFiles, file.path];
    await updateLayoutNextTick();
  };

  const trashFile = async (e: Event) => {
    e.stopPropagation();
    await file.vault.trash(file, true);
    await updateLayoutNextTick();
  };

  const openFile = async () =>
    await $app.workspace.getLeaf("tab").openFile(file);

  const pinButton = (element: HTMLElement) => setIcon(element, "pin");
  const trashIcon = (element: HTMLElement) => setIcon(element, "trash");
  const folderIcon = (element: HTMLElement) => setIcon(element, "folder");
  const sparklesIcon = (element: HTMLElement) => setIcon(element, "sparkles");
  const eyeIcon = (element: HTMLElement) => setIcon(element, "eye");
  const fileTextIcon = (element: HTMLElement) => setIcon(element, "file-text");

  onMount(() => {
    (async () => {
      await renderFile(contentDiv);
      await updateLayoutNextTick();
      translateTransition = true;
    })();
    return () => updateLayoutNextTick();
  });
</script>

<div
  class="card"
  class:transition={translateTransition}
  transition:fade
  onclick={openFile}
  role="link"
  onkeydown={openFile}
  tabindex="0"
>
  {#if ($settings.enableSummaries && displayMode === "summary" && summaryText) || displayFilename}<h1>{file.basename}</h1>{/if}

  {#if $settings.enableSummaries && displayMode === "summary" && summaryText}
    <div class="card-content card-summary" class:italics={$settings.summaryStyle === SummaryStyle.Italics}>
      <p>{summaryText}</p>
    </div>
  {:else}
    <div class="card-content" bind:this={contentDiv}></div>
  {/if}

  <div class="card-info">
    <button
      class="clickable-icon"
      class:is-active={pinned}
      use:pinButton
      onclick={togglePin}
      aria-label="Pin file"
    ></button>

    {#if $settings.enableSummaries}
      {#if summaryText}
        <button
          class="clickable-icon"
          class:is-active={displayMode === "summary"}
          use:eyeIcon
          onclick={toggleDisplayMode}
          oncontextmenu={showSummaryContextMenu}
          aria-label={displayMode === "summary" ? "Show full content" : "Show summary"}
        ></button>
      {:else}
        <button
          class="clickable-icon"
          class:is-loading={isGeneratingSummary}
          use:sparklesIcon
          onclick={generateSummary}
          aria-label="Generate summary"
        ></button>
      {/if}
    {/if}

    {#if file.parent != null && file.parent.path !== "/"}
      <div class="folder-name">
        <span use:folderIcon></span>{file.parent.path}
      </div>
    {/if}
    {#if $settings.showDeleteButton}
      <button
        class="clickable-icon"
        use:trashIcon
        onclick={trashFile}
        aria-label="Delete file"
      ></button>
    {/if}
  </div>
</div>

<style>
  .card {
    position: absolute;
    background-color: var(--background-primary-alt);
    border: 1px solid var(--background-modifier-border);
    padding: var(--card-padding);
    word-wrap: break-word;
    overflow: hidden;
    margin: 0;
  }

  .card .card-content {
    position: relative;
    overflow-x: visible;
    max-height: calc(var(--card-width) * 1.2);
  }

  .card .card-content::after {
    content: "";
    position: absolute;
    top: calc((var(--card-width) * 1.2) - 3rem);
    left: 0;
    right: 0;
    height: 3rem;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      var(--background-primary-alt) 100%
    );
    pointer-events: none;
  }

  .card.transition {
    transition-property: transform;
    transition-duration: 0.4s;
  }

  .card {
    font-size: 0.8rem;
  }

  .card :global(p),
  .card :global(ul) {
    margin: 0.3rem 0;
  }

  .card :global(h1),
  .card :global(h2),
  .card :global(h3) {
    margin: 0 0 0.3rem;
  }

  .card :global(ul) {
    padding-left: var(--size-4-5);
  }

  .card :global(p:has(> span.image-embed):not(:has(br))) {
    margin: 0;
  }

  .card :global(span.image-embed) {
    margin: 0 calc(-1 * var(--card-padding));
    width: calc(100% + 2 * var(--card-padding));
  }

  /* Images embeds alone in a paragraph */
  .card :global(p:has(> span.image-embed):not(:has(br)) span.image-embed) {
    display: block;
    & :global(img) {
      display: block;
    }
  }

  /* Image embeds followed by line break in same paragraph */
  .card :global(p:has(> span.image-embed):has(br) span.image-embed) {
    display: inline-block;
  }

  /** Embed notes */
  .card :global(p:has(> span.markdown-embed)),
  .card :global(.block-language-dataview) {
    overflow: hidden;
    max-height: 5rem;
    position: relative;
  }

  .card :global(p:has(> span.markdown-embed) > .embed-shadow),
  .card :global(.block-language-dataview > .embed-shadow) {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    box-shadow: inset 0 -2rem 1rem -1rem var(--background-primary-alt);
  }

  .card:hover {
    border-color: var(--background-modifier-border-hover);
  }

  .card :global(h3) {
    word-wrap: break-word;
  }

  .card .card-info {
    position: relative;
    z-index: 1;
    margin: calc(-1 * var(--card-padding));
    margin-top: 0;
    border-top: 1px solid var(--background-modifier-border);
    padding: var(--size-4-1) var(--card-padding);
    background-color: var(--background-primary);
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--size-4-1);
  }

  .card .card-info .clickable-icon.is-active {
    color: var(--tab-text-color-focused-active);
    background-color: var(--background-modifier-hover);
  }

  .card .card-info .folder-name {
    flex-grow: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--size-4-1);
    color: var(--text-muted);
  }

  .card .card-summary {
    color: var(--text-muted);
  }

  .card .card-summary.italics {
    font-style: italic;
  }

  .card .card-info .clickable-icon.is-loading {
    opacity: 0.5;
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }
</style>
