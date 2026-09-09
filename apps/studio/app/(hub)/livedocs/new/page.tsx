import { PublicationCreateFlow } from '../../../../components/publication-create-flow';
import { workspaceRoot } from '../../../../lib/data';
import { loadPublicationWorkspaceModel } from '../../../../lib/publication-read-model';

export const dynamic = 'force-dynamic';

export default async function NewPublicationPage() {
  const model = await loadPublicationWorkspaceModel({
    root: workspaceRoot(),
  });
  return <PublicationCreateFlow initialModel={model} />;
}
