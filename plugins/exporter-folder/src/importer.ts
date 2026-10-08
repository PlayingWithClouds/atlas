import path from "node:path";
import type { Project, Session } from "@atlas/contracts";
import type { ItemsService, JobHandle, LabelingService, SourceProvider } from "@atlas/contracts/server";
import { IMPORT_KIND, PROVIDER_ID, readLabels } from "./dataset";

export interface ImportServices {
  items: ItemsService;
  labeling: LabelingService;
  provider: SourceProvider;
}

export interface ImportSummary {
  sessionId: string;
  imported: number;
  skipped: number;
}

export async function runImport(
  services: ImportServices,
  project: Project,
  directory: string,
  job: JobHandle,
): Promise<ImportSummary> {
  const labels = readLabels(directory);
  job.phase("importing");
  const resolved = await services.provider.resolve(IMPORT_KIND, { path: directory, mediaKind: project.config.mediaKind });
  const session = services.items.createSession({
    projectId: project.id,
    label: resolved.label,
    source: { plugin: PROVIDER_ID, kind: IMPORT_KIND, params: { path: directory } },
    meta: resolved.sessionMeta,
  });
  const created = services.items.append(session.id, resolved.items);
  job.progress(0, created.length);
  job.setExtra({ projectId: project.id, directory, sessionId: session.id });

  for (const [index, item] of created.entries()) {
    if (job.signal.aborted) {
      throw new Error("import aborted");
    }
    const annotations = labels[path.relative(directory, item.ref)];
    await services.labeling.confirm(item.id, annotations);
    job.progress(index + 1);
  }
  return summaryOf(session, created.length, Object.keys(labels).length);
}

function summaryOf(session: Session, imported: number, listed: number): ImportSummary {
  return { sessionId: session.id, imported, skipped: listed - imported };
}
