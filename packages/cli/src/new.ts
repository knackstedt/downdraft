import { createLogger } from "@downdraft/core";
import { basename, resolve } from "path";
import { listTemplates, scaffold, type ScaffoldOptions } from "./scaffold.ts";

const log = createLogger();

export async function newProject(args: string[]): Promise<void> {
  const targetPath = args.find((a) => !a.startsWith("-")) ?? ".";
  const templateArg = args.find((a) => a.startsWith("--template="))?.split("=")[1] ?? "minimal";
  const nameArg = args.find((a) => a.startsWith("--name="))?.split("=")[1];
  const descriptionArg = args.find((a) => a.startsWith("--description="))?.split("=")[1];
  const authorArg = args.find((a) => a.startsWith("--author="))?.split("=")[1];
  const versionArg = args.find((a) => a.startsWith("--version="))?.split("=")[1] ?? "0.1.0";
  const aiCompanion = args.includes("--ai-companion");
  const force = args.includes("--force");
  const listFlag = args.includes("--list-templates");

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

  const absTarget = resolve(targetPath);
  const projectName = nameArg ?? basename(absTarget);

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
