import { createLogger } from "@downdraft/engine";
import { basename, resolve } from "path";
import { parseArgs, print, renderHelp } from "./args";
import { listTemplates, scaffold, type ScaffoldOptions } from "./scaffold";
import { getCommand } from "./usage";

const log = createLogger();

export async function newProject(args: string[]): Promise<void> {
  const entry = getCommand("new")!;
  const parsed = parseArgs(args, entry.schema);
  if (parsed.help) {
    print(renderHelp(entry.usage, entry.schema));
    return;
  }

  const templateArg = parsed.flags.template as string;
  const nameArg = parsed.flags.name as string | undefined;
  const descriptionArg = parsed.flags.description as string | undefined;
  const authorArg = parsed.flags.author as string | undefined;
  const versionArg = parsed.flags.version as string;
  const aiCompanion = parsed.flags["ai-companion"] as boolean;
  const force = parsed.flags.force as boolean;
  const listFlag = parsed.flags["list-templates"] as boolean;

  if (listFlag) {
    const templates = listTemplates();
    log.info("scaffold", `Available templates:`);
    for (let i = 0; i < templates.length; i++) {
      log.info("scaffold", `  - ${templates[i]}`);
    }
    return;
  }

  const availableTemplates = listTemplates();
  if (!availableTemplates.includes(templateArg)) {
    log.error("new", `Unknown template: "${templateArg}"`);
    log.info("new", `Available templates: ${availableTemplates.join(", ")}`);
    process.exit(1);
  }

  const targetPath = parsed.positionals[0] ?? ".";
  const absTarget = resolve(targetPath);
  const projectName = nameArg || basename(absTarget);

  log.info("scaffold", `
  ╔══════════════════════════════════════════╗
  ║   DownDraft Engine — New Project          ║
  ╚══════════════════════════════════════════╝
  `);

  const opts: ScaffoldOptions = {
    template: templateArg,
    name: projectName,
    description: descriptionArg,
    author: authorArg,
    version: versionArg,
    aiCompanion,
    force,
  };

  await scaffold(absTarget, opts);
}
