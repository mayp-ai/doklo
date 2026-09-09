import { loadLexiconSuggestions, loadWorkspace } from '../../../lib/data';
import { LexiconCatalog } from '../../../components/lexicon-catalog';
import { LexiconSuggestions } from '../../../components/lexicon-suggestions';
import { CanonicalLayerBoundary } from '../../../components/load-recovery';

export const dynamic = 'force-dynamic';

// Server component: reads the LLM suggestion cache + workspace config on the
// server, then mounts the client catalog. The catalog's own data (terms) now
// flows from the store (real lexicon.json wired in RootLayout), so this page
// only needs to fetch what the catalog can't reach from the store — the
// `.doklo/cache/lexicon-suggestions.json` review queue.
export default async function LexiconPage() {
  const [suggestionsFile, workspace] = await Promise.all([
    loadLexiconSuggestions(),
    loadWorkspace(),
  ]);

  // The catalog is a full-height two-pane (scrolling list + SmartSidebar), so
  // we can't drop a section as a bare sibling — its `h-full` would overflow
  // the (hub) body cell. Instead the suggestions review sits in a capped,
  // self-scrolling band on top, and the catalog takes the remaining height
  // (min-h-0 + flex-1) so its internal scroll and sidebar keep working. The
  // band renders only when there are candidates; once the user clears them
  // (accept/reject → router.refresh), it disappears.
  return (
    <CanonicalLayerBoundary layer="lexicon">
      <div className="flex h-full flex-col">
        {suggestionsFile && suggestionsFile.suggestions.length > 0 && (
          <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border bg-canvas px-7 py-5">
            <LexiconSuggestions
              initialSuggestions={suggestionsFile.suggestions}
              generatedAt={suggestionsFile.generated_at}
              corpusSize={suggestionsFile.corpus_size}
              defaultLocale={workspace?.default_locale ?? 'en'}
              suggestionsRevision={suggestionsFile.revision}
              suggestionsPath={suggestionsFile.path}
            />
          </div>
        )}
        <div className="min-h-0 flex-1">
          <LexiconCatalog />
        </div>
      </div>
    </CanonicalLayerBoundary>
  );
}
