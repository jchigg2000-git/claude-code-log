import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../config.ts";
import { invalidateMetrics, invalidateJourney } from "../api.ts";
import { buildEmbedPrompt } from "../embedPrompt.ts";
import { el, clear } from "../dom.ts";

export function openSettings(onSaved: () => void): void {
  const root = document.getElementById("modal-root")!;
  clear(root);
  const cfg = loadConfig();

  const logInput = el("input", {
    type: "text",
    value: cfg.logDir,
    spellcheck: false,
    class: "field",
  }) as HTMLInputElement;
  const repoInput = el("input", {
    type: "text",
    value: cfg.repoRoot,
    spellcheck: false,
    class: "field",
  }) as HTMLInputElement;

  const status = el("span", { class: "status" });

  const copyBtn = el(
    "button",
    {
      class: "btn",
      onclick: async () => {
        const prompt = buildEmbedPrompt({
          logDir: logInput.value.trim() || DEFAULT_CONFIG.logDir,
          repoRoot: repoInput.value.trim() || DEFAULT_CONFIG.repoRoot,
        });
        try {
          await navigator.clipboard.writeText(prompt);
          status.textContent = "Prompt copied — paste it into Claude Code in any project.";
        } catch {
          status.textContent = "Clipboard blocked; prompt printed to the console.";
          console.log(prompt);
        }
      },
    },
    "Copy embed prompt",
  );

  const close = () => clear(root);

  const overlay = el(
    "div",
    {
      class: "overlay",
      onclick: (e: Event) => {
        if (e.target === e.currentTarget) close();
      },
    },
    el(
      "div",
      { class: "modal", role: "dialog", "aria-label": "Settings" },
      el(
        "div",
        { class: "modal-head" },
        el("h2", {}, "Settings"),
        el("button", { class: "icon-btn", title: "Close", onclick: close }, "✕"),
      ),
      el(
        "label",
        { class: "field-label" },
        "Claude Code log location",
        logInput,
        el("small", { class: "hint" }, `default: ${DEFAULT_CONFIG.logDir}`),
      ),
      el(
        "label",
        { class: "field-label" },
        "Base repo root",
        repoInput,
        el("small", { class: "hint" }, `default: ${DEFAULT_CONFIG.repoRoot}`),
      ),
      el(
        "div",
        { class: "embed-row" },
        copyBtn,
        el(
          "small",
          { class: "hint" },
          "Adds this dashboard to another project using that project's own stack & styling.",
        ),
      ),
      status,
      el(
        "div",
        { class: "modal-foot" },
        el(
          "button",
          {
            class: "btn ghost",
            onclick: () => {
              logInput.value = DEFAULT_CONFIG.logDir;
              repoInput.value = DEFAULT_CONFIG.repoRoot;
            },
          },
          "Reset to defaults",
        ),
        el(
          "button",
          {
            class: "btn primary",
            onclick: () => {
              saveConfig({
                logDir: logInput.value.trim() || DEFAULT_CONFIG.logDir,
                repoRoot: repoInput.value.trim() || DEFAULT_CONFIG.repoRoot,
              });
              // Both corpus-wide scans are keyed on logDir; changing it must
              // drop the journey cache too, or the Journey tab keeps rendering
              // the previous location's history.
              invalidateMetrics();
              invalidateJourney();
              close();
              onSaved();
            },
          },
          "Save & rescan",
        ),
      ),
    ),
  );

  root.append(overlay);
  logInput.focus();
}
