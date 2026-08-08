import { confinePath, createLogger } from "@downdraft/core";
import { Eta } from "eta";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, resolve } from "path";

const log = createLogger();

const TEMPLATES_DIR = resolve(import.meta.dir, "../templates");

export interface ScaffoldOptions {
  template: string;
  name: string;
  description?: string;
  author?: string;
  version: string;
  aiCompanion: boolean;
  force: boolean;
}

export function listTemplates(): string[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  const entries = readdirSync(TEMPLATES_DIR);
  const templates: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.startsWith("_")) continue;
    const fullPath = join(TEMPLATES_DIR, entry);
    if (statSync(fullPath).isDirectory()) {
      templates.push(entry);
    }
  }
  return templates;
}

function createEtaInstance(templateDir: string): Eta {
  const eta = new Eta({
    views: templateDir,
    autoEscape: false,
    useWith: true,
    functionHeader: `
      const kebabCase = (s) => s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/\\s+/g, '-').toLowerCase();
      const pascalCase = (s) => s.replace(/(^|[-\\s])(.)/g, (_, __, c) => c.toUpperCase());
      const camelCase = (s) => { const p = pascalCase(s); return p.charAt(0).toLowerCase() + p.slice(1); };
      const titleCase = (s) => s.replace(/(^|[-\\s])(.)/g, (_, __, c) => ' ' + c.toUpperCase()).trim();
    `,
  });
  return eta;
}

export async function scaffold(targetPath: string, opts: ScaffoldOptions): Promise<void> {
  // Validate template name to prevent path traversal via the template parameter.
  // Template names must be relative, non-traversing identifiers confined to the templates dir.
  confinePath(TEMPLATES_DIR, opts.template);

  const templateDir = join(TEMPLATES_DIR, opts.template);
  if (!existsSync(templateDir)) {
    log.error("scaffold", `Template "${opts.template}" not found at ${templateDir}`);
    log.info("scaffold", `Available templates: ${listTemplates().join(", ")}`);
    process.exit(1);
  }

  // Validate the target path to prevent path traversal outside the current working directory.
  const absTarget = confinePath(process.cwd(), targetPath);

  if (existsSync(absTarget)) {
    const entries = readdirSync(absTarget);
    if (entries.length > 0 && !opts.force) {
      log.error("scaffold", `Target directory "${absTarget}" is not empty. Use --force to override.`);
      process.exit(1);
    }
  }

  mkdirSync(absTarget, { recursive: true });

  const eta = createEtaInstance(TEMPLATES_DIR);

  const templateData = {
    name: opts.name,
    description: opts.description,
    author: opts.author,
    version: opts.version,
    aiCompanion: opts.aiCompanion,
    template: opts.template,
    plugins: getPluginsForTemplate(opts.template),
  };

  log.info("scaffold", `  Template:  ${opts.template}`);
  log.info("scaffold", `  Name:       ${opts.name}`);
  log.info("scaffold", `  Version:    ${opts.version}`);
  if (opts.description) log.info("scaffold", `  Description: ${opts.description}`);
  if (opts.author) log.info("scaffold", `  Author:     ${opts.author}`);
  log.info("scaffold", `  AI Companion: ${opts.aiCompanion ? "yes" : "no"}`);
  log.info("scaffold", `  Target:     ${absTarget}`);

  const files = collectTemplateFiles(templateDir);
  let createdCount = 0;

  for (let i = 0; i < files.length; i++) {
    const relPath = files[i];
    const srcFile = join(templateDir, relPath);
    const srcBasename = basename(relPath);
    if (srcBasename === ".eta") {
      const dirPath = join(absTarget, dirname(relPath));
      mkdirSync(dirPath, { recursive: true });
      continue;
    }

    const destRel = relPath.replace(/\.eta$/, "");
    const destFile = join(absTarget, destRel);

    mkdirSync(dirname(destFile), { recursive: true });

    const content = readFileSync(srcFile, "utf-8");

    let rendered: string;
    try {
      rendered = await eta.renderStringAsync(content, templateData);
    } catch (err) {
      log.error("scaffold", `Failed to render template: ${relPath}`);
      throw err;
    }

    writeFileSync(destFile, rendered);
    createdCount++;
  }

  if (opts.aiCompanion) {
    const aiCompanionDir = join(TEMPLATES_DIR, "_shared", "ai-companion");
    if (existsSync(aiCompanionDir)) {
      const aiFiles = collectTemplateFiles(aiCompanionDir);
      for (let i = 0; i < aiFiles.length; i++) {
        const relPath = aiFiles[i];
        const srcFile = join(aiCompanionDir, relPath);
        const content = readFileSync(srcFile, "utf-8");

        let rendered: string;
        try {
          rendered = await eta.renderStringAsync(content, templateData);
        } catch (err) {
          log.error("scaffold", `Failed to render AI companion template: ${relPath}`);
          throw err;
        }

        const destMap: Record<string, string> = {
          "devin-config.eta": ".devin/config.json",
          "logging-rule.eta": ".devin/rules/logging.md",
          "loops-rule.eta": ".devin/rules/loops.md",
          "engine-prompt.eta": "engine-prompt.md",
        };

        const baseName = basename(relPath);
        const destRel = destMap[baseName];
        if (!destRel) continue;

        const destFile = join(absTarget, destRel);
        mkdirSync(dirname(destFile), { recursive: true });
        writeFileSync(destFile, rendered);
        createdCount++;
      }
    }
  }

  log.info("scaffold", `Created ${createdCount} files`);
  log.info("scaffold", `Project scaffolded at: ${absTarget}`);
  log.info("scaffold", ``);
  log.info("scaffold", `Next steps:`);
  log.info("scaffold", `  cd ${relative(process.cwd(), absTarget) || "."}`);
  log.info("scaffold", `  bun install`);
  log.info("scaffold", `  draft dev`);
}

function collectTemplateFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...collectTemplateFiles(fullPath, base));
    } else {
      const rel = relative(base, fullPath);
      results.push(rel);
    }
  }
  return results;
}

function getPluginsForTemplate(template: string): string[] {
  switch (template) {
    case "minimal":
      return [];
    case "physics":
      return ["physics-rapier"];
    case "full":
      return ["physics-rapier", "water", "marching-cubes", "models", "devtools"];
    default:
      return [];
  }
}
