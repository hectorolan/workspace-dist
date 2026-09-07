import { useApi } from '../api.js';
import { DocumentPage } from '../components/DocumentPage.jsx';
import { IndexCard, IndexRow } from '../components/IndexRow.jsx';
import { ErrorCard, Loading, Prose } from '../components/states.jsx';

/**
 * Agents index. Rows are the IndexRow template (two-line ledger idiom,
 * document-threads N3 — the half PR #32 deferred): line 1 the name and its
 * chips, the curated summary as its own line, then the machine facts — the
 * row's key with the comment count pushed right, silent at zero. These rows
 * are filesystem-backed, so the facts line carries no date. The governing-docs
 * ("Knowledge") card moved to /knowledge — the Claude section's Core subtab
 * (hn-nav-restructure-2026-08-15).
 */
export function AgentsPage() {
  const { loading, status, data, error } = useApi('/api/agents');

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const { agents } = data;

  return (
    <IndexCard
      title="Agents"
      empty={agents.length === 0 ? 'No agents found — is WORKSPACE_CLAUDE_DIR pointed at the workspace .claude directory?' : null}
    >
      {agents.map((a) => (
        <IndexRow
          key={a.name}
          href={`/agents/${a.name}`}
          title={
            <>
              {a.name}
              {a.model ? <span className="tag">{a.model}</span> : null}
            </>
          }
          // Curated README-table summary, not the frontmatter trigger text (TP-readme-summ-009).
          desc={a.summary}
          refKey={`agents/${a.name}`}
          count={a.comments}
        />
      ))}
    </IndexCard>
  );
}

/**
 * Core subtab (/knowledge): the governing docs ("Knowledge") every agent works
 * from — the same rows the Agents page used to host, fed by the same
 * /api/agents payload (no API change; hn-nav-restructure-2026-08-15).
 */
export function KnowledgeIndexPage() {
  const { loading, status, data, error } = useApi('/api/agents');

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const { knowledge } = data;

  return (
    <IndexCard
      title="Knowledge"
      sub="The governing docs every agent works from."
      empty={knowledge.length === 0 ? 'No knowledge docs found.' : null}
    >
      {knowledge.map((d) => (
        <IndexRow key={d.slug} href={`/knowledge/${d.slug}`} title={d.title} refKey={`knowledge/${d.slug}`} count={d.comments} />
      ))}
    </IndexCard>
  );
}

/** One agent: frontmatter meta + rendered body, on the DocumentPage template (N3). */
export function AgentPage({ params }) {
  const { loading, status, data, error } = useApi(`/api/agents/${encodeURIComponent(params.name)}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const agent = data.agent;

  return (
    <DocumentPage backHref="/agents" backLabel="All agents" pageType="agents" slug={agent.name}>
      <div className="card rail-accent">
        <h1>{agent.name}</h1>
        <dl className="meta">
          <dt>Model</dt>
          <dd>{agent.model || '—'}</dd>
          <dt>Tools</dt>
          <dd>{agent.tools || '—'}</dd>
          {/* The agent's own routing contract — full frontmatter text, detail only (TP-readme-summ-009). */}
          <dt>Trigger description (frontmatter)</dt>
          <dd>{agent.description || '—'}</dd>
        </dl>
      </div>
      <div className="card">
        <Prose html={agent.html} />
      </div>
    </DocumentPage>
  );
}

/** One knowledge doc (whitelisted slug), on the DocumentPage template (N3). */
export function KnowledgePage({ params }) {
  const { loading, status, data, error } = useApi(`/api/knowledge/${encodeURIComponent(params.slug)}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;

  return (
    <DocumentPage backHref="/knowledge" backLabel="All knowledge" pageType="knowledge" slug={data.doc.slug}>
      <div className="card">
        <Prose html={data.doc.html} />
      </div>
    </DocumentPage>
  );
}

/** Skills index — same IndexRow rows; the origin chip stays a row sibling
 *  (the `after` slot renders OUTSIDE the row link, never nested). */
export function SkillsPage() {
  const { loading, status, data, error } = useApi('/api/skills');

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;

  return (
    <IndexCard
      title="Skills"
      empty={data.skills.length === 0 ? 'No skills found — is WORKSPACE_CLAUDE_DIR pointed at the workspace .claude directory?' : null}
    >
      {data.skills.map((s) => (
        <IndexRow
          key={s.name}
          href={`/skills/${s.name}`}
          title={s.name}
          // Curated README-table summary, not the frontmatter trigger text (TP-readme-summ-008).
          desc={s.summary}
          refKey={`skills/${s.name}`}
          count={s.comments}
          after={
            s.upstream ? (
              // Origin column, external: sha-pinned upstream tree in a new tab
              // (TP-skills-origin-006). A sibling of the row link, never nested.
              <a
                className="origin-chip origin-external"
                href={s.upstream.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`github.com/${s.upstream.repo}${s.upstream.shaShort ? ` @ ${s.upstream.shaShort}` : ''}`}
              >
                external &#8599;
              </a>
            ) : (
              <span className="origin-chip">workspace</span>
            )
          }
        />
      ))}
    </IndexCard>
  );
}

/** One skill: rendered SKILL.md + upstream source line, on the DocumentPage template (N3). */
export function SkillPage({ params }) {
  const { loading, status, data, error } = useApi(`/api/skills/${encodeURIComponent(params.name)}`);

  if (loading) return <Loading />;
  if (error) return <ErrorCard status={status} error={error} />;
  const skill = data.skill;

  return (
    <DocumentPage backHref="/skills" backLabel="All skills" pageType="skills" slug={skill.name}>
      <div className="card rail-accent">
        <h1>{skill.name}</h1>
        {/* The skill's own routing contract — full frontmatter text, labeled so it isn't
            mistaken for the curated index summary (TP-skills-origin-008, TP-readme-summ-008). */}
        <dl className="meta">
          <dt>Trigger description (frontmatter)</dt>
          <dd>{skill.description || '—'}</dd>
        </dl>
      </div>
      {skill.upstream ? (
        <p className="ledger-meta">
          External skill — source:{' '}
          <a href={skill.upstream.url} target="_blank" rel="noopener noreferrer">
            github.com/{skill.upstream.repo}
          </a>{' '}
          (<code>{skill.upstream.path}</code>
          {skill.upstream.shaShort ? (
            <>
              {' '}
              @ <code>{skill.upstream.shaShort}</code>
            </>
          ) : null}
          )
        </p>
      ) : null}
      <div className="card">
        <Prose html={skill.html} />
      </div>
    </DocumentPage>
  );
}
