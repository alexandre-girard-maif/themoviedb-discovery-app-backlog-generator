import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

const defaultConfig = new URL(
  '../.github/backlog/backlog.yaml',
  import.meta.url,
);
const fieldNames = ['Size', 'Epic', 'Priority'];
const categoryFieldName = 'Notation';
const categoryPalette = [
  { name: 'socle', color: 'GREEN' },
  { name: 'approfondissement', color: 'BLUE' },
  { name: 'exclu', color: 'GRAY' },
];
const priorityPalette = [
  { name: 'P1', color: 'RED' },
  { name: 'P2', color: 'ORANGE' },
  { name: 'P3', color: 'YELLOW' },
];
const epicPalette = [
  { name: 'EXP', color: 'GREEN' },
  { name: 'DASH', color: 'BLUE' },
  { name: 'COMP', color: 'PURPLE' },
  { name: 'HIST', color: 'YELLOW' },
  { name: 'REC', color: 'PINK' },
  { name: 'WATCH', color: 'ORANGE' },
  { name: 'REL', color: 'GRAY' },
  { name: 'BUG', color: 'RED' },
  { name: 'DATABASE', color: 'GREEN' },
  { name: 'DASHBOARD', color: 'BLUE' },
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateBacklog(config) {
  requireValue(
    config?.version === 1,
    'Version de configuration non supportee.',
  );
  requireValue(
    typeof config.project?.title === 'string' && config.project.title.trim(),
    'Titre de projet manquant.',
  );
  requireValue(
    typeof config.project.viewName === 'string' &&
      config.project.viewName.trim(),
    'Nom de vue manquant.',
  );
  if (config.project.viewSort !== undefined) {
    const sort = config.project.viewSort;
    requireValue(
      sort !== null &&
        typeof sort.field === 'string' &&
        sort.field.trim() === sort.field &&
        sort.field.length > 0 &&
        ['asc', 'desc'].includes(sort.direction),
      'viewSort doit definir un field non vide et une direction asc ou desc.',
    );
  }
  if (config.project.backlogColumns !== undefined)
    requireValue(
      Array.isArray(config.project.backlogColumns) &&
        config.project.backlogColumns[0] === 'Title' &&
        config.project.backlogColumns.every(
          (name) =>
            typeof name === 'string' && name.trim() === name && name.length > 0,
        ) &&
        new Set(config.project.backlogColumns).size ===
          config.project.backlogColumns.length,
      'backlogColumns doit contenir des noms de champs uniques et commencer par Title.',
    );
  requireValue(
    Array.isArray(config.project.stages) &&
      config.project.stages[0] === 'Backlog' &&
      config.project.stages.every(
        (stage) => typeof stage === 'string' && stage.trim(),
      ) &&
      new Set(config.project.stages).size === config.project.stages.length,
    'Les etapes doivent etre uniques et commencer par Backlog.',
  );
  requireValue(
    Array.isArray(config.sizes) &&
      config.sizes.map((size) => size.name).join(',') === 'XS,S,M,L,XL' &&
      config.sizes.every((size) =>
        [
          'GRAY',
          'BLUE',
          'GREEN',
          'YELLOW',
          'ORANGE',
          'RED',
          'PINK',
          'PURPLE',
        ].includes(size.color),
      ),
    'Tailles attendues : XS,S,M,L,XL avec des couleurs GitHub valides.',
  );
  requireValue(
    Array.isArray(config.epics) && config.epics.length > 0,
    'Aucune evolution.',
  );
  requireValue(
    Array.isArray(config.project.typeViews) &&
      config.project.typeViews.length === 2 &&
      new Set(config.project.typeViews.map((view) => view.name)).size === 2 &&
      config.project.typeViews.every(
        (view) =>
          typeof view.name === 'string' &&
          view.name.trim() &&
          view.name !== config.project.viewName,
      ) &&
      config.project.typeViews
        .map((view) => view.type)
        .sort()
        .join(',') === 'bug,feature',
    'Vues Features et Bugs invalides.',
  );
  const tickets = new Map();
  const ticketKeys = new Set();
  const milestoneTitles = new Set();
  requireValue(
    config.milestones === undefined || Array.isArray(config.milestones),
    'La liste des milestones est invalide.',
  );
  for (const milestone of config.milestones ?? []) {
    requireValue(
      typeof milestone?.title === 'string' &&
        milestone.title.trim() === milestone.title &&
        milestone.title.length > 0 &&
        !milestoneTitles.has(milestone.title) &&
        (milestone.description === undefined ||
          typeof milestone.description === 'string'),
      'Milestone invalide ou duplique.',
    );
    milestoneTitles.add(milestone.title);
  }
  const epicIds = new Set();
  for (const epic of config.epics) {
    requireValue(
      typeof epic.id === 'string' &&
        /^[A-Z]+$/.test(epic.id) &&
        !epicIds.has(epic.id),
      'Identifiant d evolution invalide ou duplique.',
    );
    epicIds.add(epic.id);
    for (const key of ['title', 'objective']) {
      requireValue(
        typeof epic[key] === 'string' && epic[key].trim(),
        `${epic.id} : ${key} manquant.`,
      );
    }
    requireValue(
      Array.isArray(epic.tickets) && epic.tickets.length > 0,
      `${epic.id} : aucun ticket.`,
    );
    for (const ticket of epic.tickets) {
      requireValue(
        ticket.milestone === undefined || milestoneTitles.has(ticket.milestone),
        `${ticket.id} : milestone inconnu.`,
      );
      requireValue(
        typeof ticket.id === 'string' &&
          new RegExp(`^${epic.id}-\\d{2}$`).test(ticket.id) &&
          !tickets.has(ticket.id),
        'Identifiant de ticket invalide ou duplique.',
      );
      const key = ticket.key ?? ticket.id;
      requireValue(
        (ticket.key === undefined || typeof ticket.key === 'string') &&
          typeof key === 'string' &&
          /^[A-Z][A-Z0-9-]*$/.test(key) &&
          !ticketKeys.has(key),
        'Cle stable de ticket invalide ou dupliquee.',
      );
      ticketKeys.add(key);
      for (const key of ['title', 'story']) {
        requireValue(
          typeof ticket[key] === 'string' && ticket[key].trim(),
          `${ticket.id} : ${key} manquant.`,
        );
      }
      requireValue(
        ['feature', 'bug'].includes(ticket.type),
        `${ticket.id} : type attendu feature ou bug.`,
      );
      if (ticket.type === 'bug')
        requireValue(
          Array.isArray(ticket.reproduction) &&
            ticket.reproduction.length > 0 &&
            ticket.reproduction.every(
              (step) => typeof step === 'string' && step.trim(),
            ),
          `${ticket.id} : etapes de reproduction manquantes.`,
        );
      requireValue(
        ticket.scope === undefined ||
          ['backend', 'frontend'].includes(ticket.scope),
        `${ticket.id} : scope doit etre backend ou frontend.`,
      );
      requireValue(
        ticket.category === undefined ||
          categoryPalette.some((category) => category.name === ticket.category),
        `${ticket.id} : category doit etre socle, approfondissement ou exclu.`,
      );
      requireValue(
        config.sizes.some((size) => size.name === ticket.size),
        `${ticket.id} : taille inconnue.`,
      );
      requireValue(
        ['P1', 'P2', 'P3'].includes(ticket.priority),
        `${ticket.id} : priorite inconnue.`,
      );
      requireValue(
        Array.isArray(ticket.acceptance) &&
          ticket.acceptance.length > 0 &&
          ticket.acceptance.every(
            (criterion) => typeof criterion === 'string' && criterion.trim(),
          ),
        `${ticket.id} : criteres d'acceptation manquants.`,
      );
      requireValue(
        Array.isArray(ticket.definitionOfDone) &&
          ticket.definitionOfDone.length > 0 &&
          ticket.definitionOfDone.every(
            (criterion) => typeof criterion === 'string' && criterion.trim(),
          ),
        `${ticket.id} : Definition of Done manquante ou invalide.`,
      );
      requireValue(
        Array.isArray(ticket.dependsOn) &&
          ticket.dependsOn.every((id) => typeof id === 'string') &&
          new Set(ticket.dependsOn).size === ticket.dependsOn.length,
        `${ticket.id} : dependances invalides.`,
      );
      tickets.set(ticket.id, ticket);
    }
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    requireValue(tickets.has(id), `Dependance inconnue : ${id}.`);
    requireValue(!visiting.has(id), `Cycle de dependances : ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of tickets.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of tickets.keys()) visit(id);
  return config;
}

export function marker(id) {
  return `<!-- tmdb-student-backlog:${id} -->`;
}

export function issueBody(epic, ticket, config, issueUrls) {
  const dependencies = ticket.dependsOn.length
    ? ticket.dependsOn.map((id) => `- ${issueUrls.get(id) ?? id}`).join('\n')
    : 'Aucune.';
  return [
    marker(ticket.key ?? ticket.id),
    `## ${epic.title}`,
    epic.objective,
    '## User story',
    ticket.story,
    ...(ticket.type === 'bug'
      ? [
          '## Reproduction',
          ticket.reproduction
            .map((step, index) => `${index + 1}. ${step}`)
            .join('\n'),
        ]
      : []),
    '## Estimation initiale',
    `**Taille : ${ticket.size}** | **Priorité : ${ticket.priority}**`,
    'Estimation indicative à discuter en refinement. La taille ne représente ni des heures ni une note. Un ticket XL doit être découpé avant engagement en sprint.',
    "## Critères d'acceptation",
    ticket.acceptance.map((criterion) => `- [ ] ${criterion}`).join('\n'),
    '## Dépendances',
    dependencies,
    '## Definition of Done',
    ticket.definitionOfDone.map((criterion) => `- [ ] ${criterion}`).join('\n'),
  ].join('\n\n');
}

export function gh(args, input) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch (error) {
    throw new Error(
      `Echec de gh ${args.slice(0, 2).join(' ')} : ${error.stderr?.toString().trim() || error.message}`,
      { cause: error },
    );
  }
}

function graphql(run, query, variables) {
  const result = JSON.parse(
    run(
      ['api', 'graphql', '--input', '-'],
      JSON.stringify({ query, variables }),
    ),
  );
  requireValue(
    !result.errors?.length,
    `Erreur GraphQL : ${JSON.stringify(result.errors)}`,
  );
  requireValue(result.data, 'Reponse GraphQL sans donnees.');
  return result.data;
}

function json(run, args) {
  return JSON.parse(run(args));
}

export function ensureViewSorting(
  run,
  project,
  owner,
  fields,
  names,
  sort,
  log,
) {
  const field = findProjectField(fields, sort.field);
  requireValue(field?.id, `Champ de tri inconnu : ${sort.field}.`);
  const views = [];
  let cursor = null;
  do {
    const data = graphql(
      run,
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              views(first: 100, after: $cursor) {
                nodes {
                  id
                  name
                  sortByFields(first: 100) {
                    nodes {
                      direction
                      field {
                        ... on ProjectV2Field {
                          id
                        }
                        ... on ProjectV2SingleSelectField {
                          id
                        }
                        ... on ProjectV2IterationField {
                          id
                        }
                      }
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { id: project.id, cursor },
    );
    requireValue(data.node?.views, 'Impossible de lire le tri des vues.');
    views.push(...data.node.views.nodes);
    cursor = data.node.views.pageInfo.hasNextPage
      ? data.node.views.pageInfo.endCursor
      : null;
  } while (cursor);
  let endpoint;
  let fieldId;
  for (const name of new Set(names)) {
    let view = views.find((candidate) => candidate.name === name);
    if (!view && views.length === 1 && views[0].name === 'View 1') {
      ensureBacklogView(run, project.id, name, log);
      view = views[0];
      view.name = name;
    }
    if (view) {
      const criteria = view.sortByFields?.nodes;
      requireValue(
        Array.isArray(criteria),
        `Impossible de lire le tri de ${name}.`,
      );
      if (
        criteria.length !== 1 ||
        criteria[0].field?.id !== field.id ||
        criteria[0].direction !== sort.direction.toUpperCase()
      )
        log(
          `Tri de ${name} a ajuster manuellement dans GitHub : ${sort.field} (${sort.direction}). L'API ne permet pas de modifier le tri d'une vue existante.`,
        );
      continue;
    }
    if (!endpoint) {
      const account = json(run, ['api', `users/${owner}`]);
      requireValue(
        ['User', 'Organization'].includes(account.type),
        'Proprietaire du projet invalide.',
      );
      // Both endpoints require the login, despite views documenting "user_id".
      endpoint = `${account.type === 'Organization' ? 'orgs' : 'users'}/${owner}/projectsV2/${project.number}`;
      const pages = json(run, [
        'api',
        `${endpoint}/fields?per_page=100`,
        '--paginate',
        '--slurp',
        '-H',
        'X-GitHub-Api-Version: 2026-03-10',
      ]);
      requireValue(
        Array.isArray(pages) && pages.every(Array.isArray),
        'Liste des champs REST invalide.',
      );
      fieldId = pages
        .flat()
        .find((candidate) => candidate.node_id === field.id)?.id;
      requireValue(
        Number.isSafeInteger(fieldId) && fieldId > 0,
        `Identifiant REST du champ ${sort.field} absent.`,
      );
    }
    const created = JSON.parse(
      run(
        [
          'api',
          `${endpoint}/views`,
          '--method',
          'POST',
          '--input',
          '-',
          '-H',
          'X-GitHub-Api-Version: 2026-03-10',
        ],
        JSON.stringify({
          name,
          layout: 'table',
          sort_by: [[fieldId, sort.direction]],
        }),
      ),
    );
    requireValue(
      created.node_id &&
        created.name === name &&
        JSON.stringify(created.sort_by) ===
          JSON.stringify([[fieldId, sort.direction]]),
      `Creation de la vue ${name} sans le tri attendu.`,
    );
    views.push({ id: created.node_id, name });
    log(`Vue ${name} creee, tri : ${sort.field} (${sort.direction}).`);
  }
}

function ensureTypeViews(
  run,
  projectId,
  definitions,
  personal,
  nativeTypes,
  columns,
  log,
) {
  ensureFilteredViews(
    run,
    projectId,
    definitions.map((definition) => ({
      name: definition.name,
      filter: personal
        ? `label:${definition.type}`
        : `type:${nativeTypes.get(definition.type)}`,
    })),
    columns,
    log,
  );
}

function ensureFilteredViews(
  run,
  projectId,
  definitions,
  columns,
  log,
  exact = false,
) {
  for (const definition of definitions) {
    ensureBacklogView(run, projectId, definition.name, log);
    const data = graphql(
      run,
      `
        query ($id: ID!) {
          node(id: $id) {
            ... on ProjectV2 {
              views(first: 100) {
                nodes {
                  id
                  name
                  filter
                }
              }
            }
          }
        }
      `,
      { id: projectId },
    );
    const view = data.node?.views?.nodes.find(
      (candidate) => candidate.name === definition.name,
    );
    requireValue(view, `Vue ${definition.name} absente.`);
    const filter = definition.filter;
    if (view.filter !== filter) {
      graphql(
        run,
        `
          mutation ($id: ID!, $filter: String!) {
            updateProjectV2View(input: { viewId: $id, filter: $filter }) {
              projectV2View {
                id
                filter
              }
            }
          }
        `,
        { id: view.id, filter },
      );
    }
    ensureBacklogColumns(run, projectId, definition.name, columns, exact);
  }
}

function ensureBacklogView(run, projectId, name, log) {
  const views = [];
  let cursor = null;
  do {
    const data = graphql(
      run,
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              views(first: 100, after: $cursor) {
                nodes {
                  id
                  name
                  number
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { id: projectId, cursor },
    );
    requireValue(data.node?.views, 'Impossible de lire les vues du projet.');
    views.push(...data.node.views.nodes);
    cursor = data.node.views.pageInfo.hasNextPage
      ? data.node.views.pageInfo.endCursor
      : null;
  } while (cursor);
  if (views.some((view) => view.name === name)) return;
  if (views.length === 1 && views[0].name === 'View 1') {
    graphql(
      run,
      `
        mutation ($id: ID!, $name: String!) {
          updateProjectV2View(input: { viewId: $id, name: $name }) {
            projectV2View {
              id
              name
            }
          }
        }
      `,
      { id: views[0].id, name },
    );
  } else {
    graphql(
      run,
      `
        mutation ($id: ID!, $name: String!) {
          createProjectV2View(
            input: { projectId: $id, name: $name, layout: TABLE_LAYOUT }
          ) {
            projectV2View {
              id
              name
            }
          }
        }
      `,
      { id: projectId, name },
    );
  }
  log(`Vue ${name} configuree.`);
}

function ensureBacklogColumns(
  run,
  projectId,
  viewName,
  requiredIds,
  exact = false,
) {
  const data = graphql(
    run,
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on ProjectV2 {
            views(first: 100) {
              nodes {
                id
                name
                configuration {
                  visibleFields(first: 100) {
                    nodes {
                      ... on ProjectV2Field {
                        id
                      }
                      ... on ProjectV2SingleSelectField {
                        id
                      }
                      ... on ProjectV2IterationField {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { id: projectId },
  );
  const view = data.node?.views?.nodes.find(
    (candidate) => candidate.name === viewName,
  );
  requireValue(
    view?.configuration?.visibleFields,
    'Impossible de lire les colonnes de la vue Backlog.',
  );
  const ids = view.configuration.visibleFields.nodes.map((field) => field.id);
  const remaining = ids.filter((id) => !requiredIds.slice(1).includes(id));
  const titleIndex = remaining.indexOf(requiredIds[0]);
  const ordered = exact
    ? requiredIds
    : titleIndex === -1
      ? [...requiredIds, ...remaining]
      : [
          ...remaining.slice(0, titleIndex + 1),
          ...requiredIds.slice(1),
          ...remaining.slice(titleIndex + 1),
        ];
  if (
    ordered.length === ids.length &&
    ordered.every((id, index) => id === ids[index])
  )
    return;
  requireValue(ids.every(Boolean), 'Identifiant de colonne manquant.');
  graphql(
    run,
    `
      mutation ($id: ID!, $fields: [ID!]!) {
        updateProjectV2View(
          input: { viewId: $id, configuration: { visibleFieldIds: $fields } }
        ) {
          projectV2View {
            id
          }
        }
      }
    `,
    { id: view.id, fields: ordered },
  );
}

function extendSelectField(run, field, names, log) {
  requireValue(
    Array.isArray(field.options),
    `Le champ ${field.name} doit etre de type SINGLE_SELECT.`,
  );
  const missing = names.filter(
    (name) => !field.options.some((option) => option.name === name),
  );
  if (!missing.length) return;
  const data = graphql(
    run,
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on ProjectV2SingleSelectField {
            options {
              id
              name
              color
              description
            }
          }
        }
      }
    `,
    { id: field.id },
  );
  requireValue(
    Array.isArray(data.node?.options),
    `Impossible de lire les options du champ ${field.name}.`,
  );
  const additions = names
    .filter((name) => !data.node.options.some((option) => option.name === name))
    .map((name) => ({ name, color: 'GRAY', description: '' }));
  if (!additions.length) return;
  graphql(
    run,
    `
      mutation ($id: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(
          input: { fieldId: $id, singleSelectOptions: $options }
        ) {
          projectV2Field {
            ... on ProjectV2SingleSelectField {
              id
            }
          }
        }
      }
    `,
    { id: field.id, options: [...data.node.options, ...additions] },
  );
  log(
    `Options ajoutees a ${field.name} : ${additions.map((option) => option.name).join(', ')}.`,
  );
}

function ensureSelectColors(
  run,
  fieldId,
  palette,
  fieldName,
  preserveColors = false,
) {
  const data = graphql(
    run,
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on ProjectV2SingleSelectField {
            options {
              id
              name
              color
              description
            }
          }
        }
      }
    `,
    { id: fieldId },
  );
  requireValue(
    Array.isArray(data.node?.options),
    `Impossible de lire les couleurs de ${fieldName}.`,
  );
  const options = data.node.options.map((option) => {
    const entry = palette.find((candidate) => candidate.name === option.name);
    return entry && (!preserveColors || option.color === 'GRAY')
      ? { ...option, color: entry.color }
      : option;
  });
  if (
    options.every(
      (option, index) => option.color === data.node.options[index].color,
    )
  )
    return;
  graphql(
    run,
    `
      mutation ($id: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(
          input: { fieldId: $id, singleSelectOptions: $options }
        ) {
          projectV2Field {
            ... on ProjectV2SingleSelectField {
              id
            }
          }
        }
      }
    `,
    { id: fieldId, options },
  );
}

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      owner: { type: 'string' },
      config: { type: 'string' },
      'project-number': { type: 'string' },
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'update-existing': { type: 'boolean', default: false },
      'force-update': { type: 'boolean', default: false },
      'create-issues': { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  requireValue(
    !(values.apply && values['dry-run']),
    'Ne pas combiner --apply et --dry-run.',
  );
  if (values.help) return values;
  requireValue(
    typeof values.repo === 'string' && /^[A-Za-z0-9_.-]+$/.test(values.repo),
    '--repo NOM_DU_DEPOT est obligatoire (sans proprietaire).',
  );
  if (values.owner !== undefined) {
    requireValue(
      /^[A-Za-z0-9-]+$/.test(values.owner),
      '--owner doit etre un login utilisateur ou organisation valide.',
    );
    values.repo = `${values.owner}/${values.repo}`;
  }
  requireValue(
    !values['project-number'] || /^[1-9]\d*$/.test(values['project-number']),
    '--project-number doit etre un entier positif.',
  );
  requireValue(
    !values.prune || values['project-number'],
    '--prune exige --project-number pour cibler un projet existant.',
  );
  requireValue(
    !values.prune || values['create-issues'],
    '--prune exige --create-issues : aucune issue modifiee en mode brouillons.',
  );
  return values;
}

function readProjectItems(run, projectId) {
  const items = new Map();
  let cursor = null;
  do {
    const data = graphql(
      run,
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                nodes {
                  id
                  content {
                    ... on Issue {
                      url
                    }
                  }
                  fieldValues(first: 100) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField {
                            name
                          }
                        }
                      }
                      ... on ProjectV2ItemFieldNumberValue {
                        number
                        field {
                          ... on ProjectV2Field {
                            name
                          }
                        }
                      }
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `,
      { id: projectId, cursor },
    );
    requireValue(data.node?.items, 'Impossible de lire les tickets du projet.');
    for (const item of data.node.items.nodes) {
      if (item.content?.url) items.set(item.content.url, item);
    }
    cursor = data.node.items.pageInfo.hasNextPage
      ? data.node.items.pageInfo.endCursor
      : null;
  } while (cursor);
  return items;
}

function readRepositoryIssues(run, repo) {
  return json(run, [
    'api',
    `repos/${repo}/issues?state=all&per_page=100`,
    '--paginate',
    '--slurp',
  ])
    .flat()
    .filter((issue) => !issue.pull_request);
}

function pruneCandidates(config, issues, items) {
  const keys = new Set(
    config.epics.flatMap((epic) =>
      epic.tickets.map((ticket) => ticket.key ?? ticket.id),
    ),
  );
  return issues.filter((issue) => {
    const markers = [
      ...(issue.body ?? '').matchAll(
        /<!-- tmdb-student-backlog:([A-Z][A-Z0-9-]*) -->/g,
      ),
    ];
    return (
      markers.length === 1 &&
      !keys.has(markers[0][1]) &&
      items.has(issue.html_url)
    );
  });
}

function pruneIssues(config, issues, items, projectId, run, log, apply) {
  const candidates = pruneCandidates(config, issues, items);
  for (const issue of candidates) {
    log(`Prune : fermer et retirer du projet ${issue.html_url}`);
    if (!apply) continue;
    requireValue(
      Number.isInteger(issue.number) && issue.number > 0,
      'Numero d issue invalide pour --prune.',
    );
    const item = items.get(issue.html_url);
    requireValue(
      item.id,
      'Identifiant de ticket du projet manquant pour --prune.',
    );
    if (issue.state !== 'closed')
      run(
        [
          'api',
          `repos/${config.repo}/issues/${issue.number}`,
          '--method',
          'PATCH',
          '--input',
          '-',
        ],
        JSON.stringify({ state: 'closed' }),
      );
    graphql(
      run,
      `
        mutation ($project: ID!, $item: ID!) {
          deleteProjectV2Item(input: { projectId: $project, itemId: $item }) {
            deletedItemId
          }
        }
      `,
      { project: projectId, item: item.id },
    );
  }
  log(
    `Prune : ${candidates.length} ticket(s) ${apply ? 'retire(s)' : 'a retirer'}.`,
  );
}

export function syncDependencies(run, projectId, itemId, fields, ticket) {
  const field = findProjectField(fields, 'dependsOn');
  if (!field) return;
  run([
    'project',
    'item-edit',
    '--id',
    itemId,
    '--project-id',
    projectId,
    '--field-id',
    field.id,
    ...(ticket.dependsOn.length
      ? ['--text', ticket.dependsOn.join(', ')]
      : ['--clear']),
  ]);
}

function keepFieldValue(nodes, name, value, forceUpdate) {
  const normalizedName = name.toLowerCase();
  const current = nodes?.find(
    (entry) => entry.field?.name?.toLowerCase() === normalizedName,
  );
  return (
    current && (!forceUpdate || name === 'Status' || current.name === value)
  );
}

function findProjectField(fields, name) {
  const normalizedName = name.toLowerCase();
  return fields.find(
    (field) =>
      typeof field.name === 'string' &&
      field.name.toLowerCase() === normalizedName,
  );
}

function instantiateDrafts(config, options, run, log, project) {
  const items = [];
  let cursor = null;
  do {
    const data = graphql(
      run,
      `
        query ($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  fullDatabaseId
                  type
                  content {
                    ... on DraftIssue {
                      id
                      title
                      body
                    }
                    ... on Issue {
                      id
                      title
                      body
                    }
                  }
                  fieldValues(first: 100) {
                    pageInfo {
                      hasNextPage
                    }
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field {
                          ... on ProjectV2SingleSelectField {
                            id
                            name
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { id: project.id, cursor },
    );
    requireValue(
      data.node?.items,
      'Impossible de lire les brouillons du projet.',
    );
    for (const item of data.node.items.nodes) {
      requireValue(
        !item.fieldValues.pageInfo.hasNextPage,
        'Trop de champs sur un ticket du projet.',
      );
      items.push(item);
    }
    cursor = data.node.items.pageInfo.hasNextPage
      ? data.node.items.pageInfo.endCursor
      : null;
  } while (cursor);
  const tickets = config.epics.flatMap((epic) =>
    epic.tickets.map((ticket) => ({ epic, ticket })),
  );
  const matched = new Map();
  const urls = new Map();
  for (const { ticket } of tickets) {
    const matches = items.filter((item) => {
      const markers = [
        ...(item.content?.body ?? '').matchAll(
          /<!-- tmdb-student-backlog:([A-Z][A-Z0-9-]*) -->/g,
        ),
      ];
      return (
        markers.length === 1 && markers[0][1] === (ticket.key ?? ticket.id)
      );
    });
    requireValue(
      matches.length <= 1,
      `Plusieurs tickets correspondent a ${ticket.id}.`,
    );
    if (matches[0]) {
      requireValue(
        matches[0].type === 'DRAFT_ISSUE',
        `${ticket.id} est une issue : convertir manuellement ou utiliser --create-issues.`,
      );
      matched.set(ticket.id, matches[0]);
      urls.set(
        ticket.id,
        `${project.url}?pane=issue&itemId=${matches[0].fullDatabaseId}`,
      );
    }
  }
  const fields = json(run, [
    'project',
    'field-list',
    String(project.number),
    '--owner',
    options.owner,
    '--format',
    'json',
    '--limit',
    '100',
  ]).fields;
  for (const { epic, ticket } of tickets) {
    if (matched.has(ticket.id)) continue;
    const result = graphql(
      run,
      `
        mutation ($input: AddProjectV2DraftIssueInput!) {
          addProjectV2DraftIssue(input: $input) {
            projectItem {
              id
              fullDatabaseId
              content {
                ... on DraftIssue {
                  id
                  title
                  body
                }
              }
            }
          }
        }
      `,
      {
        input: {
          projectId: project.id,
          title: `[${ticket.id}] ${ticket.title}`,
          body: issueBody(epic, ticket, config, urls),
        },
      },
    );
    const item = result.addProjectV2DraftIssue?.projectItem;
    requireValue(
      item?.id && item.content?.id && item.fullDatabaseId,
      `Creation du brouillon ${ticket.id} sans identifiant.`,
    );
    matched.set(ticket.id, {
      ...item,
      fieldValues: { nodes: [] },
      created: true,
    });
    urls.set(
      ticket.id,
      `${project.url}?pane=issue&itemId=${item.fullDatabaseId}`,
    );
    log(`Brouillon cree : ${ticket.id}`);
  }
  for (const { epic, ticket } of tickets) {
    const item = matched.get(ticket.id);
    syncDependencies(run, project.id, item.id, fields, ticket);
    if (item.created || options['update-existing'] || options['force-update']) {
      const title = `[${ticket.id}] ${ticket.title}`;
      const body = issueBody(epic, ticket, config, urls);
      if (item.content.title !== title || item.content.body !== body)
        graphql(
          run,
          `
            mutation ($input: UpdateProjectV2DraftIssueInput!) {
              updateProjectV2DraftIssue(input: $input) {
                draftIssue {
                  id
                }
              }
            }
          `,
          { input: { draftIssueId: item.content.id, title, body } },
        );
    }
    for (const [name, value] of Object.entries({
      Status: 'Backlog',
      Epic: epic.id,
      Priority: ticket.priority,
      Size: ticket.size,
      ...(ticket.scope !== undefined ? { Scope: ticket.scope } : {}),
      ...(ticket.category !== undefined
        ? { [categoryFieldName]: ticket.category }
        : {}),
    })) {
      if (
        keepFieldValue(
          item.fieldValues.nodes,
          name,
          value,
          options['force-update'],
        )
      )
        continue;
      const field = findProjectField(fields, name);
      const option = field?.options?.find((option) => option.name === value);
      requireValue(option, `Option ${value} absente de ${name}.`);
      run([
        'project',
        'item-edit',
        '--id',
        item.id,
        '--project-id',
        project.id,
        '--field-id',
        field.id,
        '--single-select-option-id',
        option.id,
      ]);
    }
  }
  log(
    `${tickets.length} tickets brouillons synchronises ; aucune issue creee.`,
  );
}

export function instantiate(config, options, run = gh, log = console.log) {
  validateBacklog(config);
  requireValue(
    !options.prune || options['create-issues'],
    '--prune exige --create-issues : aucune issue modifiee en mode brouillons.',
  );
  requireValue(
    !options.prune || options['project-number'],
    '--prune exige --project-number pour cibler un projet existant.',
  );
  const allTickets = config.epics.flatMap((epic) => epic.tickets);
  if (!options.apply && !options.prune) {
    log(
      `Simulation : ${options.repo}${options.owner ? `, proprietaire ${options.owner}` : ''}, ${allTickets.length} tickets. Aucune requete GitHub.`,
    );
    const sort = config.project.viewSort ?? {
      field: 'Title',
      direction: 'asc',
    };
    log(
      `Tri des nouvelles vues : ${sort.field} (${sort.direction}). Les ecarts des vues existantes seront signales sans modification.`,
    );
    if (options['update-existing']) {
      log(
        'Avec --apply, les titres et descriptions existants seront remplaces par la configuration, y compris les modifications manuelles.',
      );
    }
    if (options['force-update'])
      log(
        'Avec --apply --force-update, le YAML remplace les contenus et champs declares, y compris les modifications manuelles. Le statut et les valeurs absentes du YAML sont conserves.',
      );
    for (const milestone of config.milestones ?? [])
      log(`Milestone | ${milestone.title}`);
    for (const epic of config.epics) {
      for (const ticket of epic.tickets)
        log(
          `Backlog | ${ticket.id} | ${ticket.size} | ${ticket.priority} | ${ticket.title}${ticket.milestone ? ` | Milestone : ${ticket.milestone}` : ''}`,
        );
    }
    return;
  }

  run(['auth', 'status']);
  if (!options.owner) {
    const user = json(run, ['api', 'user']);
    requireValue(
      typeof user.login === 'string' && /^[A-Za-z0-9-]+$/.test(user.login),
      'Impossible de determiner le proprietaire : fournir --owner pour un depot d organisation.',
    );
    options.owner = user.login;
    options.repo = `${options.owner}/${options.repo}`;
  }
  if (options.prune && !options.apply) {
    const project = json(run, [
      'project',
      'view',
      options['project-number'],
      '--owner',
      options.owner,
      '--format',
      'json',
    ]);
    requireValue(project.id && !project.closed, 'Projet absent ou ferme.');
    const issues = readRepositoryIssues(run, options.repo);
    const items = readProjectItems(run, project.id);
    pruneIssues(
      { ...config, repo: options.repo },
      issues,
      items,
      project.id,
      run,
      log,
      false,
    );
    return;
  }
  const repository = json(run, [
    'repo',
    'view',
    options.repo,
    '--json',
    'hasIssuesEnabled,viewerPermission',
  ]);
  requireValue(
    !options['create-issues'] || repository.hasIssuesEnabled,
    'Les issues doivent etre activees dans le depot cible.',
  );
  requireValue(
    ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repository.viewerPermission),
    'Un acces en ecriture au depot cible est requis.',
  );
  const repositoryDetails = json(run, ['api', `repos/${options.repo}`]);
  requireValue(
    ['Organization', 'User'].includes(repositoryDetails.owner?.type),
    'Type de proprietaire du depot inconnu.',
  );
  const personal = repositoryDetails.owner.type === 'User';
  const nativeTypes = new Map();
  if (!personal && options['create-issues']) {
    const issueTypes = json(run, [
      'api',
      `orgs/${options.repo.split('/')[0]}/issue-types`,
    ]);
    for (const type of ['feature', 'bug']) {
      const native = issueTypes.find(
        (candidate) =>
          candidate.name.toLowerCase() === type && candidate.is_enabled,
      );
      requireValue(
        native,
        `Activer le type d issue ${type} dans les parametres de l organisation avant de generer le backlog.`,
      );
      nativeTypes.set(type, native.name);
    }
  }
  log(
    !options['create-issues']
      ? 'Mode brouillons : aucune issue creee.'
      : personal
        ? 'Depot personnel : les types seront representes par des labels.'
        : 'Depot d organisation : types natifs Feature et Bug.',
  );
  const existingIssues = readRepositoryIssues(run, options.repo);
  const issueUrls = new Map();
  const issuesById = new Map();
  for (const ticket of allTickets) {
    const matches = existingIssues.filter((issue) =>
      issue.body?.includes(marker(ticket.key ?? ticket.id)),
    );
    requireValue(
      matches.length <= 1,
      `Plusieurs issues correspondent a ${ticket.id} : resoudre le doublon avant de continuer.`,
    );
    if (matches[0]) {
      issueUrls.set(ticket.id, matches[0].html_url);
      issuesById.set(ticket.id, matches[0]);
    }
  }

  const milestones = new Map();
  if (options['create-issues'] && config.milestones?.length) {
    const pages = json(run, [
      'api',
      `repos/${options.repo}/milestones?state=all&per_page=100`,
      '--paginate',
      '--slurp',
    ]);
    for (const definition of config.milestones) {
      const matches = pages
        .flat()
        .filter((milestone) => milestone.title === definition.title);
      requireValue(
        matches.length <= 1,
        `Milestone duplique : ${definition.title}.`,
      );
      const milestone =
        matches[0] ??
        JSON.parse(
          run(
            [
              'api',
              `repos/${options.repo}/milestones`,
              '--method',
              'POST',
              '--input',
              '-',
            ],
            JSON.stringify({
              title: definition.title,
              ...(definition.description !== undefined
                ? { description: definition.description }
                : {}),
            }),
          ),
        );
      requireValue(
        Number.isInteger(milestone.number) && milestone.number > 0,
        `Numero de milestone manquant : ${definition.title}.`,
      );
      milestones.set(definition.title, milestone.number);
      if (!matches.length) log(`Milestone cree : ${definition.title}`);
    }
  }

  const projectArgs = ['--owner', options.owner, '--format', 'json'];
  const projectTitle = `${config.project.title} - ${options.repo.split('/')[1]}`;
  let project;
  let isNew = false;
  if (options['project-number']) {
    project = json(run, [
      'project',
      'view',
      options['project-number'],
      ...projectArgs,
    ]);
  } else {
    const listed = json(run, [
      'project',
      'list',
      ...projectArgs,
      '--limit',
      '1000',
    ]);
    const projects = Array.isArray(listed) ? listed : listed.projects;
    requireValue(Array.isArray(projects), 'Liste des projets invalide.');
    const matches = projects.filter(
      (candidate) => candidate.title === projectTitle,
    );
    requireValue(
      matches.length <= 1,
      `Plusieurs projets nommes "${projectTitle}" : preciser --project-number.`,
    );
    project = matches[0];
    if (!project) {
      project = json(run, [
        'project',
        'create',
        ...projectArgs,
        '--title',
        projectTitle,
      ]);
      isNew = true;
    }
  }
  requireValue(
    project.id && project.number && project.url,
    'Reponse de projet incomplete.',
  );
  requireValue(!project.closed, 'Le projet cible est ferme.');
  log(`Projet : ${project.url}`);
  log(
    `Reprise : npm run backlog:instantiate -- --repo ${options.repo} --owner ${options.owner} --project-number ${project.number} --apply`,
  );
  const number = String(project.number);
  let fields = json(run, [
    'project',
    'field-list',
    number,
    ...projectArgs,
    '--limit',
    '100',
  ]).fields;
  const status = findProjectField(fields, 'Status');
  requireValue(
    status?.options,
    'Le projet doit posseder le champ natif Status.',
  );
  if (isNew) {
    graphql(
      run,
      `
        mutation (
          $id: ID!
          $options: [ProjectV2SingleSelectFieldOptionInput!]!
        ) {
          updateProjectV2Field(
            input: { fieldId: $id, singleSelectOptions: $options }
          ) {
            projectV2Field {
              ... on ProjectV2SingleSelectField {
                id
              }
            }
          }
        }
      `,
      {
        id: status.id,
        options: config.project.stages.map((name, index) => ({
          name,
          description: '',
          color: ['GRAY', 'BLUE', 'YELLOW', 'ORANGE', 'GREEN'][index % 5],
        })),
      },
    );
    fields = json(run, [
      'project',
      'field-list',
      number,
      ...projectArgs,
      '--limit',
      '100',
    ]).fields;
  }
  requireValue(
    fields
      .find((field) => field.name === 'Status')
      ?.options?.some((option) => option.name === 'Backlog'),
    'Ajouter manuellement l option Backlog au champ Status du projet existant, puis relancer.',
  );
  if (config.project.backlogColumns?.includes('dependsOn')) {
    const field = findProjectField(fields, 'dependsOn');
    if (!field)
      run([
        'project',
        'field-create',
        number,
        ...projectArgs,
        '--name',
        'dependsOn',
        '--data-type',
        'TEXT',
      ]);
    else
      requireValue(
        field.type === 'ProjectV2Field' && !field.options,
        'dependsOn doit etre un champ TEXT.',
      );
  }
  for (const [previousName, name] of [
    ['scope', 'Scope'],
    ['Catégorie', categoryFieldName],
    ['Category', categoryFieldName],
  ]) {
    const previous = fields.find((field) => field.name === previousName);
    if (!previous) continue;
    requireValue(
      !fields.some((field) => field.name === name),
      `Les champs ${previousName} et ${name} coexistent : fusionner leurs valeurs avant l'import.`,
    );
    requireValue(
      Array.isArray(previous.options),
      `Le champ ${previousName} doit etre de type SINGLE_SELECT.`,
    );
    graphql(
      run,
      `
        mutation ($id: ID!, $name: String!) {
          updateProjectV2Field(input: { fieldId: $id, name: $name }) {
            projectV2Field {
              ... on ProjectV2SingleSelectField {
                id
                name
              }
            }
          }
        }
      `,
      { id: previous.id, name },
    );
    previous.name = name;
    log(`Champ ${previousName} renomme en ${name}.`);
  }
  const specifications = [
    { name: 'Size', values: config.sizes.map((size) => size.name) },
    { name: 'Epic', values: config.epics.map((epic) => epic.id) },
    { name: 'Priority', values: ['P1', 'P2', 'P3'] },
    ...(allTickets.some((ticket) => ticket.scope !== undefined) ||
    config.project.backlogColumns?.includes('Scope')
      ? [{ name: 'Scope', values: ['backend', 'frontend'] }]
      : []),
    ...(allTickets.some((ticket) => ticket.category !== undefined) ||
    config.project.backlogColumns?.includes(categoryFieldName)
      ? [
          {
            name: categoryFieldName,
            values: categoryPalette.map((category) => category.name),
          },
        ]
      : []),
  ];
  for (const specification of specifications) {
    const field = findProjectField(fields, specification.name);
    if (!field) {
      const args = [
        'project',
        'field-create',
        number,
        ...projectArgs,
        '--name',
        specification.name,
        '--data-type',
        'SINGLE_SELECT',
      ];
      args.push('--single-select-options', specification.values.join(','));
      run(args);
    } else {
      extendSelectField(run, field, specification.values, log);
    }
  }
  fields = json(run, [
    'project',
    'field-list',
    number,
    ...projectArgs,
    '--limit',
    '100',
  ]).fields;
  run([
    'project',
    'link',
    number,
    '--owner',
    options.owner,
    '--repo',
    options.repo,
  ]);
  const visibleFields = ['Title', 'Epic', 'Size'].map((name) => {
    const field = findProjectField(fields, name);
    requireValue(field, `Champ ${name} absent.`);
    return field.id;
  });
  ensureSelectColors(run, visibleFields[2], config.sizes, 'Size');
  const priorityField = findProjectField(fields, 'Priority');
  requireValue(priorityField?.id, 'Champ Priority absent.');
  ensureSelectColors(run, priorityField.id, priorityPalette, 'Priority');
  ensureSelectColors(run, visibleFields[1], epicPalette, 'Epic', true);
  const scopeField = fields.find((field) => field.name === 'Scope');
  const categoryField = fields.find(
    (field) => field.name === categoryFieldName,
  );
  requireValue(
    !specifications.some((field) => field.name === categoryFieldName) ||
      categoryField?.id,
    `Champ ${categoryFieldName} absent.`,
  );
  if (categoryField)
    ensureSelectColors(
      run,
      categoryField.id,
      categoryPalette,
      categoryFieldName,
    );
  requireValue(
    !allTickets.some((ticket) => ticket.scope !== undefined) || scopeField?.id,
    'Champ Scope absent.',
  );
  if (allTickets.some((ticket) => ticket.scope !== undefined))
    ensureSelectColors(
      run,
      scopeField.id,
      [
        { name: 'backend', color: 'BLUE' },
        { name: 'frontend', color: 'PURPLE' },
      ],
      'Scope',
    );
  const backlogColumns = config.project.backlogColumns
    ? config.project.backlogColumns.map((name) => {
        const field = findProjectField(fields, name);
        requireValue(field?.id, `Colonne Backlog inconnue : ${name}.`);
        return field.id;
      })
    : [
        ...visibleFields,
        ...(allTickets.some((ticket) => ticket.scope !== undefined)
          ? [scopeField.id]
          : []),
        ...(categoryField ? [categoryField.id] : []),
      ];
  ensureViewSorting(
    run,
    project,
    options.owner,
    fields,
    [
      config.project.viewName,
      ...(scopeField ? ['Backlog backend', 'Backlog frontend'] : []),
      ...(options['create-issues']
        ? config.project.typeViews.map((view) => view.name)
        : []),
    ],
    config.project.viewSort ?? { field: 'Title', direction: 'asc' },
    log,
  );
  ensureBacklogColumns(
    run,
    project.id,
    config.project.viewName,
    backlogColumns,
    config.project.backlogColumns !== undefined,
  );
  if (scopeField)
    ensureFilteredViews(
      run,
      project.id,
      ['backend', 'frontend'].map((scope) => ({
        name: `Backlog ${scope}`,
        filter: `Scope:${scope}`,
      })),
      backlogColumns,
      log,
      config.project.backlogColumns !== undefined,
    );
  if (options['create-issues'])
    ensureTypeViews(
      run,
      project.id,
      config.project.typeViews,
      personal,
      nativeTypes,
      visibleFields,
      log,
    );
  if (!options['create-issues']) {
    instantiateDrafts(config, options, run, log, project);
    return;
  }
  const items = readProjectItems(run, project.id);
  if (personal) {
    const labels = json(run, [
      'api',
      `repos/${options.repo}/labels?per_page=100`,
      '--paginate',
      '--slurp',
    ]).flat();
    for (const type of new Set(allTickets.map((ticket) => ticket.type))) {
      if (!labels.some((label) => label.name.toLowerCase() === type)) {
        run(
          [
            'api',
            `repos/${options.repo}/labels`,
            '--method',
            'POST',
            '--input',
            '-',
          ],
          JSON.stringify({
            name: type,
            color: type === 'bug' ? 'd73a4a' : 'a2eeef',
            description:
              type === 'bug'
                ? 'Defaut a corriger'
                : 'Nouvelle fonctionnalite du backlog pedagogique',
          }),
        );
      }
    }
  }

  const ordered = [];
  const queued = new Set();
  function enqueue(ticket) {
    if (queued.has(ticket.id)) return;
    for (const dependency of ticket.dependsOn)
      enqueue(allTickets.find((candidate) => candidate.id === dependency));
    queued.add(ticket.id);
    ordered.push(ticket);
  }
  for (const ticket of allTickets) enqueue(ticket);

  for (const ticket of ordered) {
    const nativeType = nativeTypes.get(ticket.type);
    const epic = config.epics.find((candidate) =>
      candidate.tickets.includes(ticket),
    );
    if (!issueUrls.has(ticket.id)) {
      const issue = JSON.parse(
        run(
          [
            'api',
            `repos/${options.repo}/issues`,
            '--method',
            'POST',
            '--input',
            '-',
          ],
          JSON.stringify({
            title: `[${ticket.id}] ${ticket.title}`,
            body: issueBody(epic, ticket, config, issueUrls),
            ...(ticket.milestone
              ? { milestone: milestones.get(ticket.milestone) }
              : {}),
            ...(personal ? { labels: [ticket.type] } : { type: nativeType }),
          }),
        ),
      );
      requireValue(issue.html_url, `Creation de ${ticket.id} sans URL.`);
      issueUrls.set(ticket.id, issue.html_url);
      log(`Issue creee : ${issue.html_url}`);
    }
    const existing = issuesById.get(ticket.id);
    if (
      existing &&
      ticket.milestone &&
      (!existing.milestone ||
        (options['force-update'] &&
          existing.milestone.number !== milestones.get(ticket.milestone)))
    ) {
      requireValue(
        Number.isInteger(existing.number) && existing.number > 0,
        `Numero d issue manquant pour ${ticket.id}.`,
      );
      run(
        [
          'api',
          `repos/${options.repo}/issues/${existing.number}`,
          '--method',
          'PATCH',
          '--input',
          '-',
        ],
        JSON.stringify({ milestone: milestones.get(ticket.milestone) }),
      );
      log(`Milestone ${ticket.milestone} affecte : ${existing.html_url}`);
    }
    if (
      existing &&
      (personal
        ? !existing.labels?.some(
            (label) => label.name.toLowerCase() === ticket.type,
          )
        : existing.type?.name !== nativeType)
    ) {
      requireValue(
        Number.isInteger(existing.number) && existing.number > 0,
        `Numero d issue manquant pour ${ticket.id}.`,
      );
      run(
        [
          'api',
          `repos/${options.repo}/issues/${existing.number}${personal ? '/labels' : ''}`,
          '--method',
          personal ? 'POST' : 'PATCH',
          '--input',
          '-',
        ],
        JSON.stringify(
          personal ? { labels: [ticket.type] } : { type: nativeType },
        ),
      );
      log(
        `${personal ? `Label ${ticket.type} ajoute` : `Type ${nativeType} defini`} : ${existing.html_url}`,
      );
    }
    if (existing && personal && options['force-update']) {
      const opposite = ticket.type === 'feature' ? 'bug' : 'feature';
      const label = existing.labels?.find(
        (candidate) => candidate.name.toLowerCase() === opposite,
      );
      if (label) {
        requireValue(
          Number.isInteger(existing.number) && existing.number > 0,
          `Numero d issue manquant pour ${ticket.id}.`,
        );
        run([
          'api',
          `repos/${options.repo}/issues/${existing.number}/labels/${encodeURIComponent(label.name)}`,
          '--method',
          'DELETE',
        ]);
        log(`Label ${label.name} retire : ${existing.html_url}`);
      }
    }
    const url = issueUrls.get(ticket.id);
    const existingItem = items.get(url);
    const item =
      existingItem ??
      json(run, ['project', 'item-add', number, ...projectArgs, '--url', url]);
    requireValue(item.id, `Ajout au projet de ${ticket.id} sans identifiant.`);
    syncDependencies(run, project.id, item.id, fields, ticket);
    const values = {
      Status: 'Backlog',
      Size: ticket.size,
      Epic: epic.id,
      Priority: ticket.priority,
      ...(ticket.scope !== undefined ? { Scope: ticket.scope } : {}),
      ...(ticket.category !== undefined
        ? { [categoryFieldName]: ticket.category }
        : {}),
    };
    for (const name of [
      'Status',
      ...fieldNames,
      ...(ticket.scope !== undefined ? ['Scope'] : []),
      ...(ticket.category !== undefined ? [categoryFieldName] : []),
    ]) {
      if (
        keepFieldValue(
          existingItem?.fieldValues.nodes,
          name,
          values[name],
          options['force-update'],
        )
      )
        continue;
      const field = findProjectField(fields, name);
      requireValue(field, `Champ ${name} absent.`);
      const args = [
        'project',
        'item-edit',
        '--id',
        item.id,
        '--project-id',
        project.id,
        '--field-id',
        field.id,
      ];
      const option = field.options?.find(
        (candidate) => candidate.name === values[name],
      );
      requireValue(option, `Option ${values[name]} absente de ${name}.`);
      args.push('--single-select-option-id', option.id);
      run(args);
    }
  }
  let updated = 0;
  if (options['update-existing'] || options['force-update']) {
    for (const epic of config.epics) {
      for (const ticket of epic.tickets) {
        const existing = issuesById.get(ticket.id);
        if (!existing) continue;
        const title = `[${ticket.id}] ${ticket.title}`;
        const body = issueBody(epic, ticket, config, issueUrls);
        if (existing.title === title && existing.body === body) continue;
        requireValue(
          Number.isInteger(existing.number) && existing.number > 0,
          `Numero d issue manquant pour ${ticket.id}.`,
        );
        run(
          [
            'api',
            `repos/${options.repo}/issues/${existing.number}`,
            '--method',
            'PATCH',
            '--input',
            '-',
          ],
          JSON.stringify({ title, body }),
        );
        updated++;
        log(`Contenu mis a jour : ${existing.html_url}`);
      }
    }
  }
  if (options.prune)
    pruneIssues(
      { ...config, repo: options.repo },
      existingIssues,
      items,
      project.id,
      run,
      log,
      true,
    );
  log(
    `${allTickets.length} tickets presents dans le projet. ${updated} contenu(s) mis a jour. ${
      options['force-update']
        ? 'Les champs declares dans le YAML sont synchronises ; le statut et les valeurs absentes sont conserves.'
        : 'Les champs deja renseignes sont conserves.'
    }`,
  );
}

export function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log(
      '--force-update : synchronise les titres, descriptions et champs declares depuis le YAML ; conserve le statut, les valeurs absentes du YAML et les commentaires.',
    );
    console.log(
      '--apply utilise des brouillons par defaut. Ajouter --create-issues pour creer des issues ; --prune exige aussi --create-issues.',
    );
    console.log(
      'Usage : npm run backlog:instantiate -- --repo NOM_DU_DEPOT [--owner LOGIN] [--config FILE] [--project-number N] [--update-existing | --force-update] [--prune] [--dry-run | --apply]\nSans --apply : simulation locale, sauf --prune qui consulte GitHub sans ecriture.\nSans --owner, le login gh authentifie est utilise ; fournir --owner pour cibler une organisation.\n--prune exige --project-number : ferme les issues generees absentes du YAML et les retire uniquement du projet cible.\n--update-existing : remplace les titres et descriptions, y compris les modifications manuelles ; conserve les champs et commentaires.',
    );
    return;
  }
  const config = parse(
    readFileSync(
      options.config ? resolve(options.config) : defaultConfig,
      'utf8',
    ),
  );
  instantiate(config, options);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
