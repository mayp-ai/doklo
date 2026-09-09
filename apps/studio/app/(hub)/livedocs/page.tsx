import { PublicationWorkbench } from '../../../components/publication-workbench';
import { workspaceRoot } from '../../../lib/data';
import { loadPublicationWorkspaceModel } from '../../../lib/publication-read-model';

export const dynamic = 'force-dynamic';

export default async function LivedocsPage({
  searchParams,
}: {
  searchParams: Promise<{
    publication?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const model = await loadPublicationWorkspaceModel({
    root: workspaceRoot(),
  });
  return (
    <PublicationWorkbench
      initialModel={model}
      initialPublicationName={
        typeof params.publication === 'string'
          ? params.publication
          : undefined
      }
    />
  );
}
