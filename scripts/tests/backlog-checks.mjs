import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  instantiate,
  ensureViewSorting,
  issueBody,
  marker,
  parseOptions,
  syncDependencies,
  validateBacklog,
} from '../instantiate-backlog.mjs';

const configuredBacklog = parse(
  readFileSync(
    new URL('../../.github/backlog/backlog.yaml', import.meta.url),
    'utf8',
  ),
);

const config = {
  ...structuredClone(configuredBacklog),
  milestones: [],
  epics: ['EXP', 'REL', 'WATCH', 'BUG'].map((id) => ({
    id,
    title: `Evolution ${id}`,
    objective: 'Verifier un import reproductible.',
    tickets: [1, 2, 3].map((number) => ({
      id: `${id}-0${number}`,
      type: id === 'BUG' ? 'bug' : 'feature',
      title: `Ticket ${id} ${number}`,
      story: 'En tant qu etudiant, je veux un ticket verifiable.',
      size: number === 1 ? 'S' : 'M',
      priority: 'P1',
      dependsOn:
        id === 'EXP' && number === 1
          ? ['REL-01']
          : id === 'WATCH' && number > 1
            ? [`WATCH-0${number - 1}`]
            : [],
      acceptance: ['Un resultat observable est verifie.'],
      definitionOfDone: ['Le resultat du ticket est relu et demontre.'],
      ...(id === 'BUG'
        ? { reproduction: ['Declencher le defaut et observer le resultat.'] }
        : {}),
    })),
  })),
};
delete config.project.backlogColumns;

function titleSort() {
  return { nodes: [{ field: { id: 'title' }, direction: 'ASC' }] };
}

test('viewSort defaults to ascending Title and validates explicit configuration', () => {
  assert.deepEqual(configuredBacklog.project.viewSort, {
    field: 'Title',
    direction: 'asc',
  });
  const legacy = structuredClone(config);
  delete legacy.project.viewSort;
  validateBacklog(legacy);
  const logs = [];
  instantiate(
    legacy,
    { repo: 'movies' },
    () => assert.fail('No GitHub calls'),
    (line) => logs.push(line),
  );
  assert.ok(logs.some((line) => line.includes('Title (asc)')));
  for (const sort of [
    null,
    {},
    { field: '', direction: 'asc' },
    { field: ' Title', direction: 'asc' },
    { field: 'Title', direction: 'ascending' },
    { field: 42, direction: 'desc' },
  ]) {
    const invalid = structuredClone(config);
    invalid.project.viewSort = sort;
    assert.throws(() => validateBacklog(invalid), /viewSort/);
  }
  legacy.project.viewSort = { field: 'Priority', direction: 'desc' };
  validateBacklog(legacy);
});

test('legacy field names are renamed without recreating fields or changing option IDs', () => {
  const f = fixture({ existing: true, scope: 'backend' });
  const field = {
    id: 'category',
    name: 'Catégorie',
    options: ['socle', 'approfondissement', 'exclu'].map((name, index) => ({
      id: name,
      name,
      color: ['GREEN', 'BLUE', 'GRAY'][index],
      description: '',
    })),
  };
  let scopeName = 'scope';
  const renames = [];
  const run = (args, input) => {
    if (args[1] === 'field-list') {
      const result = JSON.parse(f.run(args, input));
      result.fields.find((candidate) => candidate.id === 'scope').name =
        scopeName;
      result.fields.push(field);
      return JSON.stringify(result);
    }
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (query.includes('updateProjectV2Field') && variables.name) {
        renames.push(variables);
        if (variables.id === 'scope') scopeName = variables.name;
        else field.name = variables.name;
        return JSON.stringify({ data: { updateProjectV2Field: {} } });
      }
      if (variables.id === 'category')
        return JSON.stringify({ data: { node: { options: field.options } } });
    }
    assert.ok(
      !(
        args[1] === 'field-create' &&
        (args.includes('Scope') || args.includes('Notation'))
      ),
    );
    return f.run(args, input);
  };
  instantiate(f.small, f.options, run, () => {});
  instantiate(f.small, f.options, run, () => {});
  assert.deepEqual(renames, [
    { id: 'scope', name: 'Scope' },
    { id: 'category', name: 'Notation' },
  ]);
  assert.deepEqual(
    field.options.map((option) => option.id),
    ['socle', 'approfondissement', 'exclu'],
  );
});

test('view sorting uses owner logins for fields and view creation and preserves existing views', () => {
  for (const type of ['User', 'Organization']) {
    const views = [
      { id: 'custom', name: 'Custom', sortByFields: { nodes: [] } },
      { id: 'backlog', name: 'Backlog', sortByFields: titleSort() },
      { id: 'features', name: 'Features', sortByFields: { nodes: [] } },
    ];
    const original = structuredClone(views);
    const logs = [];
    const creations = [];
    let queries = 0;
    const run = (args, input) => {
      if (args[1] === 'graphql') {
        const { variables } = JSON.parse(input);
        queries++;
        return JSON.stringify({
          data: {
            node: {
              views: {
                nodes: variables.cursor ? views.slice(1) : views.slice(0, 1),
                pageInfo: { hasNextPage: !variables.cursor, endCursor: 'next' },
              },
            },
          },
        });
      }
      if (args[1] === 'users/student') return JSON.stringify({ id: 42, type });
      assert.ok(args.includes('X-GitHub-Api-Version: 2026-03-10'));
      if (args[1].includes('/fields?')) {
        const ownerPath = type === 'User' ? 'users/student' : 'orgs/student';
        assert.equal(args[1], `${ownerPath}/projectsV2/7/fields?per_page=100`);
        assert.ok(args.includes('--paginate') && args.includes('--slurp'));
        return JSON.stringify([[], [{ id: 123, node_id: 'title' }]]);
      }
      const ownerPath = type === 'User' ? 'users/student' : 'orgs/student';
      assert.equal(args[1], `${ownerPath}/projectsV2/7/views`);
      assert.ok(args.includes('POST'));
      const payload = JSON.parse(input);
      creations.push(payload);
      return JSON.stringify({
        node_id: payload.name,
        name: payload.name,
        sort_by: payload.sort_by,
      });
    };
    ensureViewSorting(
      run,
      { id: 'project', number: 7 },
      'student',
      [{ id: 'title', name: 'Title' }],
      ['Backlog', 'Features', 'Bugs', 'Backlog backend', 'Backlog frontend'],
      { field: 'Title', direction: 'asc' },
      (line) => logs.push(line),
    );
    assert.equal(queries, 2);
    assert.deepEqual(views, original);
    assert.deepEqual(
      creations,
      ['Bugs', 'Backlog backend', 'Backlog frontend'].map((name) => ({
        name,
        layout: 'table',
        sort_by: [[123, 'asc']],
      })),
    );
    assert.equal(
      logs.filter((line) => line.includes('manuellement')).length,
      1,
    );
    assert.ok(logs.some((line) => line.includes('Tri de Features')));
    assert.ok(!logs.some((line) => line.includes('Tri de Backlog ')));
  }
});

test('view sorting supports descending custom fields and surfaces failures', () => {
  const fields = [{ id: 'priority', name: 'Priority' }];
  const sort = { field: 'Priority', direction: 'desc' };
  const project = { id: 'project', number: 7 };
  const run = (args, input) => {
    if (args[1] === 'graphql')
      return JSON.stringify({
        data: {
          node: { views: { nodes: [], pageInfo: { hasNextPage: false } } },
        },
      });
    if (args[1] === 'users/student')
      return JSON.stringify({ id: 42, type: 'User' });
    if (args[1].includes('/fields?')) {
      assert.equal(args[1], 'users/student/projectsV2/7/fields?per_page=100');
      return JSON.stringify([[{ id: 9, node_id: 'priority' }]]);
    }
    assert.equal(args[1], 'users/student/projectsV2/7/views');
    const payload = JSON.parse(input);
    assert.deepEqual(payload.sort_by, [[9, 'desc']]);
    return JSON.stringify({
      node_id: 'view',
      name: payload.name,
      sort_by: payload.sort_by,
    });
  };
  ensureViewSorting(
    run,
    project,
    'student',
    fields,
    ['Backlog'],
    sort,
    () => {},
  );
  assert.throws(
    () =>
      ensureViewSorting(
        () => assert.fail('No GitHub calls'),
        project,
        'student',
        fields,
        ['Backlog'],
        { field: 'Missing', direction: 'asc' },
        () => {},
      ),
    /Champ de tri inconnu/,
  );
  for (const failure of ['api', 'fields', 'sort']) {
    const failing = (args, input) => {
      if (failure === 'api' && args[1].endsWith('/views'))
        throw new Error('REST forbidden');
      if (failure === 'fields' && args[1].includes('/fields?')) return '[[]]';
      if (failure === 'sort' && args[1].endsWith('/views'))
        return JSON.stringify({
          node_id: 'view',
          name: 'Backlog',
          sort_by: [],
        });
      return run(args, input);
    };
    assert.throws(
      () =>
        ensureViewSorting(
          failing,
          project,
          'student',
          fields,
          ['Backlog'],
          sort,
          () => {},
        ),
      /REST forbidden|Identifiant REST|sans le tri attendu/,
    );
  }
});

test('backlog accepts a growing set of ideas with unique tickets', () => {
  validateBacklog(configuredBacklog);
  const tickets = configuredBacklog.epics.flatMap((epic) => epic.tickets);
  assert.equal(
    new Set(tickets.map((ticket) => ticket.id)).size,
    tickets.length,
  );
});

test('DASHBOARD preserves the stable keys of the former EXPL issues', () => {
  const epic = configuredBacklog.epics.find(
    (candidate) => candidate.id === 'DASHBOARD',
  );
  assert.ok(epic);
  assert.deepEqual(
    epic.tickets.slice(0, 6).map((ticket) => ticket.key),
    [
      'EXPL-01',
      'EXPL-02',
      'EXPL-GENRES',
      'EXPL-GENRES-CSV',
      'EXPL-COUNTRIES-CSV',
      'EXPL-COUNTRIES-CSV-IMPORT',
    ],
  );
  for (const ticket of epic.tickets) {
    assert.ok(ticket.id.startsWith('DASHBOARD-'));
    assert.ok(ticket.dependsOn.every((id) => id.startsWith('DASHBOARD-')));
  }
});

test('each ticket requires its own nonempty Definition of Done', () => {
  for (const definitionOfDone of [undefined, null, [], [''], [' '], [42]]) {
    const invalid = structuredClone(config);
    invalid.epics[0].tickets[0].definitionOfDone = definitionOfDone;
    assert.throws(() => validateBacklog(invalid), /Definition of Done/);
  }
  const epic = config.epics[0];
  const first = {
    ...epic.tickets[0],
    definitionOfDone: ['Premier livrable verifie.'],
  };
  const second = {
    ...epic.tickets[1],
    definitionOfDone: ['Second livrable demontre.'],
  };
  const firstBody = issueBody(epic, first, config, new Map());
  const secondBody = issueBody(epic, second, config, new Map());
  assert.ok(firstBody.includes('- [ ] Premier livrable verifie.'));
  assert.ok(!firstBody.includes('Second livrable demontre.'));
  assert.ok(secondBody.includes('- [ ] Second livrable demontre.'));
  assert.ok(!secondBody.includes('Premier livrable verifie.'));
});

test('milestones are optional, unique and referenced by title', () => {
  const valid = structuredClone(config);
  delete valid.milestones;
  validateBacklog(valid);
  valid.milestones = [{ title: '1.1.0', description: 'Release' }];
  valid.epics[0].tickets[0].milestone = '1.1.0';
  validateBacklog(valid);
  for (const milestones of [
    null,
    [{ title: '' }],
    [{ title: 1.1 }],
    [{ title: '1.1.0', description: 42 }],
    [{ title: '1.1.0' }, { title: '1.1.0' }],
    [],
  ]) {
    assert.throws(
      () => validateBacklog({ ...valid, milestones }),
      /milestone/i,
    );
  }
});

test('milestone simulation stays local and displays definitions and ticket references', () => {
  const simulation = structuredClone(config);
  simulation.milestones = [{ title: '1.1.0' }];
  simulation.epics[0].tickets[0].milestone = '1.1.0';
  const output = [];
  instantiate(
    simulation,
    { repo: 'student/movies', owner: 'student', apply: false },
    () => assert.fail('Unexpected GitHub call'),
    (line) => output.push(line),
  );
  assert.ok(output.includes('Milestone | 1.1.0'));
  assert.ok(output.some((line) => line.includes('Milestone : 1.1.0')));
});

test('milestones are created or reused across pages without overwriting existing assignments', () => {
  for (const scenario of [
    'create',
    'reuse',
    'assign',
    'preserve',
    'unassigned',
  ]) {
    const f = fixture({ existing: ['assign', 'preserve'].includes(scenario) });
    if (scenario === 'preserve') f.options['update-existing'] = true;
    f.small.milestones = [{ title: '1.1.0', description: 'Release' }];
    if (scenario !== 'unassigned')
      f.small.epics[0].tickets[0].milestone = '1.1.0';
    const milestoneCalls = [];
    const run = (args, input) => {
      if (args[0] === 'api' && args[1].includes('/milestones')) {
        milestoneCalls.push({ args, input });
        if (args[1].includes('?')) {
          assert.ok(args.includes('--paginate'));
          assert.ok(args[1].includes('state=all'));
          return JSON.stringify([
            [],
            scenario === 'create' || scenario === 'unassigned'
              ? []
              : [{ title: '1.1.0', number: 5, state: 'closed' }],
          ]);
        }
        assert.deepEqual(JSON.parse(input), f.small.milestones[0]);
        return JSON.stringify({ number: 5 });
      }
      if (args[0] === 'api' && args[1].includes('/issues?')) {
        const pages = JSON.parse(f.run(args, input));
        if (scenario === 'preserve') pages[0][0].milestone = { number: 9 };
        return JSON.stringify(pages);
      }
      if (args[0] === 'api' && args[1].endsWith('/issues/1') && input) {
        f.calls.push({ args, input });
        return '{}';
      }
      return f.run(args, input);
    };
    instantiate(f.small, f.options, run, () => {});
    assert.equal(
      milestoneCalls.length,
      ['create', 'unassigned'].includes(scenario) ? 2 : 1,
    );
    const assignments = f.calls.filter(
      (call) => call.input && JSON.parse(call.input).milestone === 5,
    );
    assert.equal(
      assignments.length,
      ['preserve', 'unassigned'].includes(scenario) ? 0 : 1,
    );
    assert.ok(
      !f.calls.some(
        (call) => call.input && JSON.parse(call.input).milestone === null,
      ),
    );
  }
});

test('milestone API failures and invalid responses stop the import', () => {
  for (const response of [null, { number: 0 }]) {
    const f = fixture();
    f.small.milestones = [{ title: '1.1.0' }];
    const run = (args, input) => {
      if (args[0] === 'api' && args[1].includes('/milestones')) {
        if (!response) throw new Error('Permission refusee');
        return args[1].includes('?') ? '[[]]' : JSON.stringify(response);
      }
      return f.run(args, input);
    };
    assert.throws(
      () => instantiate(f.small, f.options, run, () => {}),
      /Permission refusee|Numero de milestone/,
    );
    assert.ok(!f.calls.some((call) => call.args[0] === 'project'));
  }
});

test('invalid sizing, priorities, stories and criteria are rejected', () => {
  for (const [key, value] of [
    ['size', 'XXL'],
    ['priority', 'P0'],
    ['story', ''],
    ['acceptance', []],
  ]) {
    const invalid = structuredClone(config);
    invalid.epics[0].tickets[0][key] = value;
    assert.throws(() => validateBacklog(invalid));
  }
  const invalid = structuredClone(config);
  invalid.sizes[1].color = 'INVALID';
  assert.throws(() => validateBacklog(invalid), /couleurs/);
});

test('unknown dependencies, duplicated identifiers and cycles are rejected', () => {
  const unknown = structuredClone(config);
  unknown.epics[0].tickets[0].dependsOn = ['MISSING-01'];
  assert.throws(() => validateBacklog(unknown), /inconnue/);
  const cycle = structuredClone(config);
  cycle.epics[0].tickets[0].dependsOn = [cycle.epics[0].tickets[0].id];
  assert.throws(() => validateBacklog(cycle), /Cycle/);
  const duplicate = structuredClone(config);
  duplicate.epics[0].tickets.push(duplicate.epics[0].tickets[0]);
  assert.throws(() => validateBacklog(duplicate), /duplique/);
});

test('stable ticket keys must be valid and unique including implicit keys', () => {
  for (const key of ['', null, 42, 'with spaces', 'WATCH-02']) {
    const invalid = structuredClone(config);
    invalid.epics.find((epic) => epic.id === 'WATCH').tickets[0].key = key;
    assert.throws(() => validateBacklog(invalid), /Cle stable/);
  }
  const duplicate = structuredClone(config);
  duplicate.epics[0].tickets[0].key = 'SHARED';
  duplicate.epics[0].tickets[1].key = 'SHARED';
  assert.throws(() => validateBacklog(duplicate), /Cle stable/);
});

test('renumbering keeps existing issue identity and dependencies across reruns', () => {
  const f = fixture({ existing: true });
  const epic = f.small.epics[0];
  const original = epic.tickets[0];
  original.key = original.id;
  original.id = 'WATCH-02';
  const inserted = {
    ...structuredClone(original),
    id: 'WATCH-01',
    key: 'WATCH-NEW',
    title: 'Nouvelle étape',
    dependsOn: [],
  };
  original.dependsOn = [inserted.id];
  epic.tickets.unshift(inserted);
  const issues = [
    {
      number: 1,
      title: '[WATCH-01] Ancienne étape',
      body: marker('WATCH-01'),
      type: { name: 'Feature' },
      html_url: 'https://github.com/student/movies/issues/1',
      milestone: { number: 9 },
    },
  ];
  const fields = JSON.parse(f.run(['project', 'field-list'])).fields;
  const originalItem = {
    id: 'original',
    content: { url: issues[0].html_url },
    fieldValues: {
      nodes: fields.map((field) => ({
        field: { name: field.name },
        name: 'Done',
        number: 8,
      })),
    },
  };
  const items = [structuredClone(originalItem)];
  let created = 0;
  let updated = 0;
  function run(args, input) {
    if (args[0] === 'api' && args[1].includes('/issues?'))
      return JSON.stringify([issues]);
    if (
      args[0] === 'api' &&
      args[1].endsWith('/issues') &&
      args.includes('POST')
    ) {
      created++;
      const payload = JSON.parse(input);
      const issue = {
        ...payload,
        number: 2,
        type: { name: payload.type },
        html_url: 'https://github.com/student/movies/issues/2',
      };
      issues.push(issue);
      return JSON.stringify(issue);
    }
    if (args[0] === 'api' && args.includes('PATCH')) {
      const number = Number(args[1].split('/').at(-1));
      Object.assign(
        issues.find((issue) => issue.number === number),
        JSON.parse(input),
      );
      updated++;
      return '{}';
    }
    if (args[1] === 'item-add') {
      const item = {
        id: 'new',
        content: { url: issues[1].html_url },
        fieldValues: { nodes: [] },
      };
      items.push(item);
      return JSON.stringify(item);
    }
    if (args[1] === 'item-edit') {
      const item = items.find(
        (item) => item.id === args[args.indexOf('--id') + 1],
      );
      assert.notEqual(item.id, 'original');
      const field = fields.find(
        (field) => field.id === args[args.indexOf('--field-id') + 1],
      );
      item.fieldValues.nodes.push({ field: { name: field.name } });
      return '';
    }
    if (
      args[1] === 'graphql' &&
      JSON.parse(input).query.includes('items(first: 100')
    )
      return JSON.stringify({
        data: {
          node: { items: { nodes: items, pageInfo: { hasNextPage: false } } },
        },
      });
    return f.run(args, input);
  }
  const options = { ...f.options, 'update-existing': true };
  instantiate(f.small, options, run, () => {});
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.equal(issues[0].title, `[WATCH-02] ${original.title}`);
  assert.ok(issues[0].body.startsWith(marker('WATCH-01')));
  assert.ok(issues[0].body.includes(issues[1].html_url));
  assert.ok(issues[1].body.startsWith(marker('WATCH-NEW')));
  assert.equal(issues[0].milestone.number, 9);
  assert.deepEqual(items[0], originalItem);
  instantiate(f.small, options, run, () => {});
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.equal(items.length, 2);
});

test('target is explicit and writes require --apply', () => {
  const options = parseOptions(['--repo', 'movies', '--owner', 'student']);
  assert.equal(options.apply, false);
  const defaultOwner = parseOptions(['--repo', 'movies']);
  assert.equal(defaultOwner.repo, 'movies');
  assert.equal(defaultOwner.owner, undefined);
  assert.equal(defaultOwner.apply, false);
  assert.throws(
    () => parseOptions(['--repo', 'org/movies', '--owner', 'student']),
    /sans proprietaire/,
  );
  assert.throws(() => parseOptions([]), /--repo/);
  assert.throws(
    () =>
      parseOptions([
        '--repo',
        'movies',
        '--owner',
        'student',
        '--project-number',
        '0',
      ]),
    /entier/,
  );
  assert.throws(() => parseOptions(['--apply', '--dry-run']), /combiner/);
});

test('authenticated user is the default owner when --owner is omitted', () => {
  const f = fixture();
  const options = parseOptions(['--repo', 'movies', '--apply']);
  options['create-issues'] = true;
  const calls = [];
  const run = (args, input) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user')
      return JSON.stringify({ login: 'student' });
    return f.run(args, input);
  };
  instantiate(f.small, options, run, () => {});
  assert.ok(
    calls.some((args) => args[0] === 'repo' && args[2] === 'student/movies'),
  );
  assert.ok(
    calls.some(
      (args) =>
        args[0] === 'project' &&
        args.includes('--owner') &&
        args.includes('student'),
    ),
  );
});

test('simulation performs no GitHub calls and displays every ticket in Backlog', () => {
  const output = [];
  instantiate(
    config,
    { repo: 'student/movies', owner: 'student', apply: false },
    () => assert.fail('Unexpected GitHub call'),
    (line) => output.push(line),
  );
  assert.equal(
    output.filter((line) => line.startsWith('Backlog |')).length,
    config.epics.reduce((total, epic) => total + epic.tickets.length, 0),
  );
});

test('scope supports backend/frontend and remains optional for older configurations', () => {
  validateBacklog(config);
  assert.ok(
    configuredBacklog.epics
      .flatMap((epic) => epic.tickets)
      .every((ticket) => ['backend', 'frontend'].includes(ticket.scope)),
  );
  for (const scope of ['backend', 'frontend']) {
    const f = fixture();
    f.small.epics[0].tickets[0].scope = scope;
    const field = {
      id: 'scope',
      name: 'Scope',
      options: [
        { id: 'backend', name: 'backend', color: 'GRAY', description: 'API' },
        { id: 'frontend', name: 'frontend', color: 'GRAY', description: 'UI' },
        { id: 'custom', name: 'other', color: 'GREEN', description: 'Custom' },
      ],
    };
    const originalOptions = structuredClone(field.options);
    let paletteChanges = 0;
    const edits = [];
    const run = (args, input) => {
      if (args[1] === 'graphql') {
        const { query, variables } = JSON.parse(input);
        if (variables.id === 'scope') {
          if (query.includes('updateProjectV2Field')) {
            field.options = variables.options;
            paletteChanges++;
            return JSON.stringify({ data: { updateProjectV2Field: {} } });
          }
          return JSON.stringify({ data: { node: { options: field.options } } });
        }
      }
      if (args[1] === 'field-list') {
        const result = JSON.parse(f.run(args, input));
        result.fields.push(field);
        return JSON.stringify(result);
      }
      if (args[1] === 'item-edit' && args.includes('scope')) edits.push(args);
      if (
        args[1] === 'graphql' &&
        JSON.parse(input).query.includes('visibleFields(first: 100)')
      ) {
        const result = JSON.parse(f.run(args, input));
        const view = result.data.node.views.nodes.find(
          (view) => view.name === 'Backlog',
        );
        view.configuration.visibleFields.nodes.push({ id: 'scope' });
        return JSON.stringify(result);
      }
      return f.run(args, input);
    };
    instantiate(f.small, f.options, run, () => {});
    assert.equal(edits.length, 1);
    assert.ok(edits[0].includes(scope));
    instantiate(f.small, f.options, run, () => {});
    assert.equal(paletteChanges, 1);
    assert.deepEqual(
      field.options,
      originalOptions.map((option) => ({
        ...option,
        color:
          { backend: 'BLUE', frontend: 'PURPLE' }[option.name] ?? option.color,
      })),
    );
    const viewWrites = f.calls
      .filter(({ args }) => args[1] === 'graphql')
      .map(({ input }) => JSON.parse(input));
    assert.deepEqual(
      f.calls
        .filter(({ args }) => args[1].endsWith('/views'))
        .map(({ input }) => JSON.parse(input).name),
      ['Backlog backend', 'Backlog frontend'],
    );
    assert.deepEqual(
      viewWrites
        .filter(({ variables }) => variables.filter !== undefined)
        .map(({ variables }) => variables.filter),
      ['Scope:backend', 'Scope:frontend'],
    );
    for (const viewName of ['Backlog backend', 'Backlog frontend'])
      assert.ok(
        viewWrites.some(
          ({ variables }) =>
            variables.id === viewName &&
            variables.fields?.join(',') === 'title,epic,size,scope',
        ),
      );
  }
  for (const scope of ['feature', '', null, 42]) {
    const invalid = structuredClone(config);
    invalid.epics[0].tickets[0].scope = scope;
    assert.throws(() => validateBacklog(invalid), /scope/);
  }
});

test('category is optional and accepts only the three grading categories', () => {
  assert.ok(configuredBacklog.project.backlogColumns.includes('Notation'));
  const withoutCategories = structuredClone(config);
  for (const epic of withoutCategories.epics)
    for (const ticket of epic.tickets) delete ticket.category;
  validateBacklog(withoutCategories);
  for (const category of ['socle', 'approfondissement', 'exclu']) {
    const valid = structuredClone(config);
    valid.epics[0].tickets[0].category = category;
    validateBacklog(valid);
  }
  for (const category of ['', null, 42, 'Socle', 'other']) {
    const invalid = structuredClone(config);
    invalid.epics[0].tickets[0].category = category;
    assert.throws(() => validateBacklog(invalid), /category/);
  }
});

test('category field is created, colored and displayed in Backlog views without assigning a default', () => {
  const f = fixture({ existing: true, scope: 'backend' });
  f.small.project.backlogColumns = ['Title', 'Notation', 'Scope'];
  let field;
  let creations = 0;
  let colorChanges = 0;
  const columns = [];
  const run = (args, input) => {
    if (args[1] === 'field-create' && args.includes('Notation')) {
      creations++;
      assert.ok(args.includes('SINGLE_SELECT'));
      assert.ok(args.includes('socle,approfondissement,exclu'));
      field = {
        id: 'category',
        name: 'Notation',
        options: [
          ...['socle', 'approfondissement', 'exclu'].map((name) => ({
            id: name,
            name,
            color: 'GRAY',
            description: name,
          })),
          { id: 'custom', name: 'custom', color: 'PINK', description: 'keep' },
        ],
      };
      return '';
    }
    if (args[1] === 'field-list') {
      const data = JSON.parse(f.run(args, input));
      if (field) data.fields.push(field);
      return JSON.stringify(data);
    }
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (variables.id === 'category') {
        if (query.includes('updateProjectV2Field')) {
          field.options = variables.options;
          colorChanges++;
          return JSON.stringify({ data: { updateProjectV2Field: {} } });
        }
        return JSON.stringify({ data: { node: { options: field.options } } });
      }
      if (variables.fields) columns.push(variables);
    }
    assert.ok(!(args[1] === 'item-edit' && args.includes('category')));
    return f.run(args, input);
  };
  instantiate(f.small, f.options, run, () => {});
  instantiate(f.small, f.options, run, () => {});
  assert.equal(creations, 1);
  assert.equal(colorChanges, 1);
  assert.deepEqual(
    field.options.map((option) => option.color),
    ['GREEN', 'BLUE', 'GRAY', 'PINK'],
  );
  assert.deepEqual(
    field.options.map(({ color: _color, ...option }) => option),
    [
      ...['socle', 'approfondissement', 'exclu'].map((name) => ({
        id: name,
        name,
        description: name,
      })),
      { id: 'custom', name: 'custom', description: 'keep' },
    ],
  );
  for (const id of ['view', 'Backlog backend', 'Backlog frontend'])
    assert.ok(
      columns.some(
        (view) =>
          view.id === id && view.fields.join(',') === 'title,category,scope',
      ),
    );
});

test('categories are assigned to issues and drafts, preserved on reruns and overridden only when declared with force-update', () => {
  for (const drafts of [false, true]) {
    const f = fixture({ existing: true });
    const ticket = f.small.epics[0].tickets[0];
    ticket.category = 'socle';
    const field = {
      id: 'category',
      name: 'Notation',
      options: ['socle', 'approfondissement', 'exclu'].map((name, i) => ({
        id: name,
        name,
        color: ['GREEN', 'BLUE', 'GRAY'][i],
        description: '',
      })),
    };
    let selected;
    const edits = [];
    const run = (args, input) => {
      if (args[1] === 'repos/student/movies/issues/1' && args.includes('PATCH'))
        return '{}';
      if (args[1] === 'field-list') {
        const data = JSON.parse(f.run(args, input));
        data.fields.push(field);
        return JSON.stringify(data);
      }
      if (args[1] === 'graphql') {
        const { query, variables } = JSON.parse(input);
        if (variables.id === 'category')
          return JSON.stringify({ data: { node: { options: field.options } } });
        if (query.includes('items(first:')) {
          const values = selected
            ? [{ field: { name: 'Notation' }, name: selected }]
            : [];
          if (drafts)
            return JSON.stringify({
              data: {
                node: {
                  items: {
                    nodes: [
                      {
                        id: 'item',
                        fullDatabaseId: '123',
                        type: 'DRAFT_ISSUE',
                        content: {
                          id: 'draft',
                          title: `[${ticket.id}] ${ticket.title}`,
                          body: marker(ticket.id),
                        },
                        fieldValues: {
                          nodes: values,
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            });
          const data = JSON.parse(f.run(args, input));
          for (const item of data.data.node.items.nodes)
            item.fieldValues.nodes.push(...values);
          return JSON.stringify(data);
        }
      }
      if (args[1] === 'item-edit' && args.includes('category')) {
        selected = args[args.indexOf('--single-select-option-id') + 1];
        edits.push(selected);
        return '';
      }
      return f.run(args, input);
    };
    const options = { ...f.options, 'create-issues': !drafts };
    instantiate(f.small, options, run, () => {});
    assert.deepEqual(edits, ['socle']);
    ticket.category = 'approfondissement';
    instantiate(f.small, options, run, () => {});
    assert.deepEqual(edits, ['socle']);
    instantiate(f.small, { ...options, 'force-update': true }, run, () => {});
    assert.deepEqual(edits, ['socle', 'approfondissement']);
    delete ticket.category;
    instantiate(f.small, { ...options, 'force-update': true }, run, () => {});
    assert.deepEqual(edits, ['socle', 'approfondissement']);
  }
});

test('Backlog configured columns are exact, ordered and do not change other views', () => {
  const f = fixture({ existing: true });
  f.small.project.backlogColumns = ['Title', 'Priority', 'Status'];
  const updates = [];
  const run = (args, input) => {
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (query.includes('updateProjectV2View')) updates.push(variables);
    }
    return f.run(args, input);
  };
  instantiate(f.small, f.options, run, () => {});
  assert.deepEqual(updates, [
    { id: 'view', fields: ['title', 'priority', 'status'] },
  ]);
  for (const columns of [
    [],
    ['Priority'],
    ['Title', 'Title'],
    ['Title', ''],
    ['Title', 42],
    'Title',
  ]) {
    const invalid = structuredClone(config);
    invalid.project.backlogColumns = columns;
    assert.throws(() => validateBacklog(invalid), /backlogColumns/);
  }
  f.small.project.backlogColumns = ['Title', 'Missing'];
  assert.throws(
    () => instantiate(f.small, f.options, run, () => {}),
    /Colonne Backlog inconnue/,
  );
});

test('dependsOn text reflects YAML dependencies and clears obsolete values', () => {
  const calls = [];
  const run = (args) => calls.push(args);
  const fields = [{ id: 'dependencies', name: 'dependsOn' }];
  syncDependencies(run, 'project', 'item', fields, {
    dependsOn: ['DASHBOARD-01', 'DASHBOARD-12'],
  });
  assert.deepEqual(calls[0].slice(-2), [
    '--text',
    'DASHBOARD-01, DASHBOARD-12',
  ]);
  syncDependencies(run, 'project', 'item', fields, { dependsOn: [] });
  assert.equal(calls[1].at(-1), '--clear');
  syncDependencies(run, 'project', 'item', [], { dependsOn: [] });
  assert.equal(calls.length, 2);
});

test('prune requires an existing project number', () => {
  assert.throws(
    () => parseOptions(['--repo', 'movies', '--prune']),
    /--project-number/,
  );
});

test('prune only closes obsolete generated issues in the targeted project and is repeatable', () => {
  for (const apply of [false, true]) {
    const f = fixture({ existing: true });
    const obsolete = {
      number: 99,
      body: marker('OLD-01'),
      state: 'open',
      html_url: 'https://github.com/student/movies/issues/99',
    };
    const alreadyClosed = {
      ...obsolete,
      number: 98,
      state: 'closed',
      body: marker('OLD-02'),
      html_url: 'https://github.com/student/movies/issues/98',
    };
    const unrelated = {
      ...obsolete,
      number: 97,
      body: 'Manual issue',
      html_url: 'manual',
    };
    const outside = {
      ...obsolete,
      number: 96,
      body: marker('OLD-03'),
      html_url: 'outside',
    };
    const ambiguous = {
      ...obsolete,
      number: 95,
      body: `${marker('OLD-04')}\n${marker('OLD-05')}`,
      html_url: 'ambiguous',
    };
    const items = new Map(
      [obsolete, alreadyClosed, unrelated, ambiguous].map((issue) => [
        issue.html_url,
        {
          id: `item-${issue.number}`,
          content: { url: issue.html_url },
          fieldValues: { nodes: [] },
        },
      ]),
    );
    const writes = [];
    const run = (args, input) => {
      if (args[1]?.includes('/issues?')) {
        const original = JSON.parse(f.run(args, input)).flat();
        return JSON.stringify([
          original,
          [obsolete, alreadyClosed, unrelated, outside, ambiguous],
        ]);
      }
      if (
        args.includes('PATCH') &&
        args[1] === 'repos/student/movies/issues/99'
      ) {
        writes.push('close');
        obsolete.state = 'closed';
        assert.deepEqual(JSON.parse(input), { state: 'closed' });
        return JSON.stringify(obsolete);
      }
      if (args[1] === 'graphql') {
        const { query, variables } = JSON.parse(input);
        if (query.includes('deleteProjectV2Item')) {
          writes.push(variables.item);
          const entry = [...items].find(
            ([, item]) => item.id === variables.item,
          );
          assert.ok(entry);
          items.delete(entry[0]);
          return JSON.stringify({
            data: { deleteProjectV2Item: { deletedItemId: variables.item } },
          });
        }
        if (query.includes('items(first: 100')) {
          const original = JSON.parse(f.run(args, input));
          original.data.node.items.nodes.push(...items.values());
          return JSON.stringify(original);
        }
      }
      return f.run(args, input);
    };
    const output = [];
    const options = { ...f.options, apply, prune: true, 'project-number': '7' };
    instantiate(f.small, options, run, (line) => output.push(line));
    assert.deepEqual(writes, apply ? ['close', 'item-99', 'item-98'] : []);
    assert.ok(output.some((line) => line.includes('2 ticket(s)')));
    assert.ok(items.has('manual') && items.has('ambiguous'));
    if (apply) {
      instantiate(f.small, options, run, () => {});
      assert.equal(writes.length, 3);
    } else {
      assert.ok(
        !f.calls.some(
          ({ args }) => args.includes('POST') || args[1] === 'item-edit',
        ),
      );
    }
  }
});

test('prune surfaces closure failures before removing an issue from the project', () => {
  const f = fixture();
  let deleted = false;
  const run = (args, input) => {
    if (args[1]?.includes('/issues?'))
      return JSON.stringify([
        [
          {
            number: 99,
            state: 'open',
            body: marker('OLD-01'),
            html_url: 'obsolete',
          },
        ],
      ]);
    if (args.includes('PATCH') && args[1]?.endsWith('/issues/99'))
      throw new Error('Closure denied');
    if (args[1] === 'graphql') {
      const { query } = JSON.parse(input);
      if (query.includes('deleteProjectV2Item')) deleted = true;
      if (query.includes('items(first: 100'))
        return JSON.stringify({
          data: {
            node: {
              items: {
                nodes: [
                  {
                    id: 'old',
                    content: { url: 'obsolete' },
                    fieldValues: { nodes: [] },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
    }
    return f.run(args, input);
  };
  assert.throws(
    () =>
      instantiate(
        f.small,
        { ...f.options, prune: true, 'project-number': '7' },
        run,
        () => {},
      ),
    /Closure denied/,
  );
  assert.equal(deleted, false);
});

test('issue body includes story, size, criteria, dependency URLs and Done without weights', () => {
  const epic = config.epics.find((candidate) => candidate.id === 'EXP');
  const ticket = epic.tickets[0];
  const body = issueBody(
    epic,
    ticket,
    config,
    new Map([['REL-01', 'https://github.com/student/movies/issues/1']]),
  );
  for (const text of [
    marker(ticket.id),
    ticket.story,
    '**Taille : S**',
    '- [ ]',
    'https://github.com/student/movies/issues/1',
    'Definition of Done',
    'ni des heures ni une note',
  ]) {
    assert.ok(body.includes(text), text);
  }
  assert.ok(body.includes(`## ${epic.title}\n\n${epic.objective}`));
  assert.ok(body.indexOf(`## ${epic.title}`) < body.indexOf('## User story'));
  assert.ok(!body.includes('## Epic'));
  assert.ok(!body.includes('Poids'));
});

function fixture({
  existing = false,
  existingProject = false,
  scope,
  missingSize = false,
  failEdit = false,
} = {}) {
  const small = structuredClone(config);
  small.epics = [small.epics.find((epic) => epic.id === 'WATCH')];
  small.epics[0].tickets = [small.epics[0].tickets[0]];
  const ticket = small.epics[0].tickets[0];
  if (scope !== undefined) ticket.scope = scope;
  const url = 'https://github.com/student/movies/issues/1';
  const fields = [
    { id: 'title', name: 'Title' },
    {
      id: 'status',
      name: 'Status',
      options: [{ id: 'backlog', name: 'Backlog' }],
    },
    {
      id: 'size',
      name: 'Size',
      options: small.sizes.map((size) => ({ id: size.name, name: size.name })),
    },
    { id: 'epic', name: 'Epic', options: [{ id: 'WATCH', name: 'WATCH' }] },
    {
      id: 'priority',
      name: 'Priority',
      options: ['P1', 'P2', 'P3'].map((name) => ({ id: name, name })),
    },
  ];
  if (scope !== undefined)
    fields.push({
      id: 'scope',
      name: 'Scope',
      options: [
        { id: 'backend', name: 'backend', color: 'BLUE' },
        { id: 'frontend', name: 'frontend', color: 'PURPLE' },
      ],
    });
  const calls = [];
  const extraViews = [];
  const typeViews = ['Features', 'Bugs'].map((name, index) => ({
    id: `type-view-${index}`,
    name,
    number: index + 2,
    filter: `type:${index === 0 ? 'Feature' : 'Bug'}`,
    configuration: {
      visibleFields: {
        nodes: [{ id: 'title' }, { id: 'epic' }, { id: 'size' }],
      },
    },
  }));
  function run(args, input) {
    calls.push({ args, input });
    const command = args.slice(0, 2).join(' ');
    if (command === 'auth status' || command === 'project link') return '';
    if (args[0] === 'api' && args[1] === 'user')
      return JSON.stringify({ login: 'student' });
    if (args[0] === 'api' && args[1] === 'users/student')
      return JSON.stringify({ id: 42, type: 'User' });
    if (args[0] === 'api' && args[1].includes('/fields?'))
      return JSON.stringify([
        fields.map((field, index) => ({
          id: index + 1,
          node_id: field.id,
          name: field.name,
        })),
      ]);
    if (args[0] === 'api' && args[1].endsWith('/views')) {
      const payload = JSON.parse(input);
      const view = {
        id: payload.name,
        name: payload.name,
        number: extraViews.length + 4,
        filter: '',
        sortByFields: titleSort(),
        configuration: { visibleFields: { nodes: [{ id: 'title' }] } },
      };
      extraViews.push(view);
      return JSON.stringify({
        node_id: view.id,
        name: view.name,
        sort_by: payload.sort_by,
      });
    }
    if (command === 'repo view')
      return JSON.stringify({
        hasIssuesEnabled: true,
        viewerPermission: 'WRITE',
      });
    if (command === 'project list')
      return JSON.stringify({
        projects: existingProject
          ? [
              {
                id: 'project',
                number: 7,
                title: `${small.project.title} - movies`,
                url: 'https://github.com/users/student/projects/7',
              },
            ]
          : [],
      });
    if (args[0] === 'api' && args[1].includes('/issues?')) {
      return JSON.stringify([
        existing
          ? [
              {
                number: 1,
                type: { name: 'Feature' },
                body: marker(ticket.id),
                html_url: url,
              },
            ]
          : [],
      ]);
    }
    if (command === 'project create' || command === 'project view')
      return JSON.stringify({
        id: 'project',
        number: 7,
        url: 'https://github.com/users/student/projects/7',
      });
    if (args[0] === 'api' && args[1] === 'repos/student/movies')
      return JSON.stringify({ owner: { type: 'Organization' } });
    if (args[0] === 'api' && args[1] === 'orgs/student/issue-types')
      return JSON.stringify([
        { name: 'Feature', is_enabled: true },
        { name: 'Bug', is_enabled: true },
      ]);
    if (command === 'project field-list') return JSON.stringify({ fields });
    if (command === 'api graphql') {
      const payload = JSON.parse(input);
      if (payload.query.includes('createProjectV2View')) {
        const view = {
          id: payload.variables.name,
          name: payload.variables.name,
          number: extraViews.length + 4,
          filter: '',
          configuration: {
            visibleFields: { nodes: [{ id: 'title' }] },
          },
        };
        extraViews.push(view);
        return JSON.stringify({
          data: { createProjectV2View: { projectV2View: view } },
        });
      }
      if (
        payload.variables.id === 'size' &&
        /options\s*\{\s*id\s+name\s+color\s+description\s*\}/.test(
          payload.query,
        )
      )
        return JSON.stringify({
          data: {
            node: {
              options: small.sizes.map((size) => ({
                id: size.name,
                name: size.name,
                color: size.color,
                description: '',
              })),
            },
          },
        });
      if (
        /options\s*\{\s*id\s+name\s+color\s+description\s*\}/.test(
          payload.query,
        )
      ) {
        const field = fields.find((field) => field.id === payload.variables.id);
        if (field?.options)
          return JSON.stringify({
            data: {
              node: {
                options: field.options.map((option) => ({
                  ...option,
                  color:
                    {
                      P1: 'RED',
                      P2: 'ORANGE',
                      P3: 'YELLOW',
                      WATCH: 'ORANGE',
                      backend: 'BLUE',
                      frontend: 'PURPLE',
                    }[option.name] ?? 'GRAY',
                  description: '',
                })),
              },
            },
          });
      }
      if (payload.query.includes('visibleFields(first: 100)'))
        return JSON.stringify({
          data: {
            node: {
              views: {
                nodes: [
                  ...extraViews,
                  ...typeViews,
                  {
                    id: 'view',
                    name: 'Backlog',
                    configuration: {
                      visibleFields: {
                        nodes: [
                          { id: 'title' },
                          { id: 'epic' },
                          { id: 'size' },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        });
      if (payload.query.includes('views(first: 100'))
        return JSON.stringify({
          data: {
            node: {
              views: {
                nodes: [
                  {
                    id: 'view',
                    name: 'Backlog',
                    number: 1,
                    sortByFields: titleSort(),
                  },
                  ...extraViews,
                  ...typeViews.map((view) => ({
                    ...view,
                    sortByFields: titleSort(),
                  })),
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      if (payload.query.includes('updateProjectV2Field'))
        return JSON.stringify({ data: { updateProjectV2Field: {} } });
      if (payload.query.includes('updateProjectV2View')) {
        const view = extraViews.find(
          (candidate) => candidate.id === payload.variables.id,
        );
        if (view) {
          if (payload.variables.filter !== undefined)
            view.filter = payload.variables.filter;
          if (payload.variables.fields)
            view.configuration.visibleFields.nodes =
              payload.variables.fields.map((id) => ({ id }));
        }
        return JSON.stringify({
          data: {
            updateProjectV2View: {
              projectV2View: { id: payload.variables.id },
            },
          },
        });
      }
      if (payload.query.includes('dataType'))
        return JSON.stringify({ data: { node: { dataType: 'NUMBER' } } });
      const nodes = existing
        ? [
            {
              id: 'item',
              content: { url },
              fieldValues: {
                nodes: fields
                  .filter((field) => !(missingSize && field.name === 'Size'))
                  .map((field) => ({
                    field: { name: field.name },
                    name: 'student-edited',
                    number: 5,
                  })),
              },
            },
          ]
        : [];
      return JSON.stringify({
        data: { node: { items: { nodes, pageInfo: { hasNextPage: false } } } },
      });
    }
    if (args[0] === 'api' && args[1].endsWith('/issues'))
      return JSON.stringify({ html_url: url });
    if (command === 'project item-add') return JSON.stringify({ id: 'item' });
    if (command === 'project item-edit') {
      if (failEdit) throw new Error('Permission refusee');
      return '';
    }
    assert.fail(`Unhandled command: ${args.join(' ')}`);
  }
  return {
    small,
    calls,
    run,
    options: {
      repo: 'student/movies',
      owner: 'student',
      apply: true,
      'create-issues': true,
      ...(existing ? { 'project-number': '7' } : {}),
    },
  };
}

test('apply reuses the generated-title project when no project number is given', () => {
  const f = fixture({ existingProject: true });
  delete f.options['project-number'];
  instantiate(f.small, f.options, f.run, () => {});
  assert.ok(
    f.calls.some(({ args }) => args.slice(0, 2).join(' ') === 'project list'),
  );
  assert.ok(
    !f.calls.some(
      ({ args }) => args.slice(0, 2).join(' ') === 'project create',
    ),
  );
  assert.ok(
    f.calls.some(
      ({ args }) =>
        args.slice(0, 2).join(' ') === 'project field-list' &&
        args.includes('7'),
    ),
  );
});

test('apply rejects duplicate projects with the generated title', () => {
  const f = fixture({ existingProject: true });
  delete f.options['project-number'];
  const listProjects = f.run;
  f.run = (args, input) => {
    if (args.slice(0, 2).join(' ') === 'project list') {
      const result = JSON.parse(listProjects(args, input));
      result.projects.push({ ...result.projects[0], number: 8 });
      return JSON.stringify(result);
    }
    return listProjects(args, input);
  };
  assert.throws(
    () => instantiate(f.small, f.options, f.run, () => {}),
    /preciser --project-number/,
  );
  assert.ok(
    !f.calls.some(
      ({ args }) => args.slice(0, 2).join(' ') === 'project create',
    ),
  );
});

test('apply defaults to draft tickets, reuses stable keys and never creates issues', () => {
  const f = fixture({ existing: true, scope: 'frontend' });
  f.small.project.backlogColumns = ['Title', 'Scope', 'Status'];
  const draftOptions = { ...f.options, 'create-issues': false };
  let items = [];
  let creates = 0;
  let scopeEdits = 0;
  const mutations = [];
  function drafts(args, input) {
    if (args[1] === 'field-list') {
      const data = JSON.parse(f.run(args, input));
      data.fields.find((field) => field.name === 'scope').name = 'Scope';
      return JSON.stringify(data);
    }
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (query.includes('... on DraftIssue') && query.includes('items(first:'))
        return JSON.stringify({
          data: {
            node: { items: { nodes: items, pageInfo: { hasNextPage: false } } },
          },
        });
      if (query.includes('addProjectV2DraftIssue')) {
        creates++;
        const item = {
          id: 'draft-item',
          fullDatabaseId: '123',
          type: 'DRAFT_ISSUE',
          content: {
            id: 'draft',
            title: variables.input.title,
            body: variables.input.body,
          },
          fieldValues: { nodes: [], pageInfo: { hasNextPage: false } },
        };
        items.push(item);
        return JSON.stringify({
          data: { addProjectV2DraftIssue: { projectItem: item } },
        });
      }
      if (query.includes('updateProjectV2DraftIssue')) {
        mutations.push(variables.input);
        Object.assign(items[0].content, variables.input);
        return JSON.stringify({
          data: { updateProjectV2DraftIssue: { draftIssue: { id: 'draft' } } },
        });
      }
    }
    if (args[1] === 'item-edit') {
      const field = args[args.indexOf('--field-id') + 1];
      if (field === 'scope') scopeEdits++;
      const name = {
        status: 'Status',
        size: 'Size',
        epic: 'Epic',
        priority: 'Priority',
        scope: 'Scope',
      }[field];
      items[0].fieldValues.nodes.push({ field: { name }, name: 'kept' });
      return '';
    }
    return f.run(args, input);
  }
  instantiate(f.small, draftOptions, drafts, () => {});
  instantiate(f.small, draftOptions, drafts, () => {});
  assert.equal(creates, 1);
  assert.equal(scopeEdits, 1);
  const viewWrites = f.calls
    .filter(({ args }) => args[1] === 'graphql')
    .map(({ input }) => JSON.parse(input));
  assert.deepEqual(
    f.calls
      .filter(({ args }) => args[1].endsWith('/views'))
      .map(({ input }) => JSON.parse(input).name),
    ['Backlog backend', 'Backlog frontend'],
  );
  assert.deepEqual(
    viewWrites
      .filter(({ variables }) => variables.filter !== undefined)
      .map(({ variables }) => variables.filter),
    ['Scope:backend', 'Scope:frontend'],
  );
  for (const name of ['Backlog backend', 'Backlog frontend'])
    assert.ok(
      viewWrites.some(
        ({ variables }) =>
          variables.id === name &&
          variables.fields?.join(',') === 'title,scope,status',
      ),
    );
  assert.ok(
    f.calls
      .filter(({ args }) => args.includes('POST'))
      .every(({ args }) => args[1].endsWith('/views')),
  );
  assert.equal(parseOptions(['--repo', 'movies'])['create-issues'], false);
  assert.throws(
    () =>
      parseOptions(['--repo', 'movies', '--prune', '--project-number', '7']),
    /--create-issues/,
  );
  draftOptions['update-existing'] = true;
  f.small.epics[0].tickets[0].title = 'Updated draft';
  instantiate(f.small, draftOptions, drafts, () => {});
  assert.equal(mutations.length, 1);
  assert.ok(items[0].content.title.includes('Updated draft'));
  const originalRun = drafts;
  const edits = [];
  const forceRun = (args, input) => {
    if (args[1] === 'item-edit') {
      const field = args[args.indexOf('--field-id') + 1];
      const name = {
        size: 'Size',
        epic: 'Epic',
        priority: 'Priority',
        scope: 'Scope',
      }[field];
      assert.ok(name, 'Existing status must be preserved');
      const value = items[0].fieldValues.nodes.find(
        (value) => value.field.name === name,
      );
      value.name = args[args.indexOf('--single-select-option-id') + 1];
      edits.push(name);
      return '';
    }
    return originalRun(args, input);
  };
  delete draftOptions['update-existing'];
  draftOptions['force-update'] = true;
  const ticket = f.small.epics[0].tickets[0];
  ticket.title = 'Forced title';
  ticket.priority = 'P2';
  ticket.size = 'L';
  ticket.scope = 'backend';
  instantiate(f.small, draftOptions, forceRun, () => {});
  assert.deepEqual(edits.sort(), ['Epic', 'Priority', 'Scope', 'Size']);
  assert.ok(items[0].content.title.includes('Forced title'));
  const count = edits.length;
  instantiate(f.small, draftOptions, forceRun, () => {});
  assert.equal(edits.length, count);
  delete ticket.scope;
  instantiate(f.small, draftOptions, forceRun, () => {});
  assert.equal(edits.length, count);
  assert.equal(
    items[0].fieldValues.nodes.find((value) => value.field.name === 'Scope')
      .name,
    'backend',
  );
});

test('force-update synchronizes issue content and declared fields, preserving status and absent values', () => {
  const f = fixture({ existing: true, scope: 'backend' });
  const ticket = f.small.epics[0].tickets[0];
  ticket.priority = 'P2';
  ticket.size = 'L';
  ticket.milestone = '2.0.0';
  f.small.milestones = [{ title: '2.0.0' }];
  const existing = {
    number: 1,
    html_url: 'https://github.com/student/movies/issues/1',
    title: 'Manual title',
    body: marker(ticket.id),
    milestone: { number: 9 },
    type: { name: 'Bug' },
    state: 'closed',
  };
  const nodes = ['Status', 'Size', 'Epic', 'Priority', 'Scope', 'Custom'].map(
    (name) => ({
      field: { name },
      name: 'manual',
    }),
  );
  const edits = [];
  const patches = [];
  const run = (args, input) => {
    if (args[1].includes('/issues?')) return JSON.stringify([[existing]]);
    if (args[1].includes('/milestones?'))
      return JSON.stringify([[{ title: '2.0.0', number: 5 }]]);
    if (args.includes('PATCH')) {
      const patch = JSON.parse(input);
      patches.push(patch);
      if (patch.milestone) existing.milestone = { number: patch.milestone };
      if (patch.type) existing.type = { name: patch.type };
      if (patch.title) Object.assign(existing, patch);
      return '{}';
    }
    if (
      args[1] === 'graphql' &&
      JSON.parse(input).query.includes('items(first:')
    ) {
      const result = JSON.parse(f.run(args, input));
      result.data.node.items.nodes[0].fieldValues.nodes = nodes;
      return JSON.stringify(result);
    }
    if (args[1] === 'item-edit') {
      const field = args[args.indexOf('--field-id') + 1];
      const name = {
        size: 'Size',
        epic: 'Epic',
        priority: 'Priority',
        scope: 'Scope',
      }[field];
      assert.ok(name, 'Status and custom fields must not be overwritten');
      nodes.find((entry) => entry.field.name === name).name =
        args[args.indexOf('--single-select-option-id') + 1];
      edits.push(name);
      return '';
    }
    return f.run(args, input);
  };
  const options = { ...f.options, 'force-update': true };
  instantiate(f.small, options, run, () => {});
  assert.deepEqual(edits.sort(), ['Epic', 'Priority', 'Scope', 'Size']);
  assert.equal(existing.milestone.number, 5);
  assert.equal(existing.type.name, 'Feature');
  assert.equal(existing.title, `[${ticket.id}] ${ticket.title}`);
  assert.ok(existing.body.includes('Taille : L'));
  assert.equal(existing.state, 'closed');
  assert.equal(
    nodes.find((entry) => entry.field.name === 'Status').name,
    'manual',
  );
  const count = patches.length;
  instantiate(f.small, options, run, () => {});
  assert.equal(patches.length, count);
  assert.equal(edits.length, 4);
  delete ticket.scope;
  delete ticket.milestone;
  instantiate(f.small, options, run, () => {});
  assert.equal(existing.milestone.number, 5);
  assert.equal(
    nodes.find((entry) => entry.field.name === 'Scope').name,
    'backend',
  );
  assert.equal(edits.length, 4);
});

test('force-update simulation stays local and warns about overwrites', () => {
  const options = parseOptions([
    '--repo',
    'movies',
    '--force-update',
    '--dry-run',
  ]);
  assert.equal(options['force-update'], true);
  const output = [];
  instantiate(
    config,
    options,
    () => assert.fail('Unexpected GitHub call'),
    (line) => output.push(line),
  );
  assert.ok(output.some((line) => line.includes('modifications manuelles')));
  assert.ok(output.some((line) => line.includes('statut')));
});

test('force-update removes only the opposite type label in a personal repository', () => {
  const f = fixture({ existing: true });
  const ticket = f.small.epics[0].tickets[0];
  const existing = {
    number: 1,
    html_url: 'https://github.com/student/movies/issues/1',
    title: `[${ticket.id}] ${ticket.title}`,
    body: issueBody(f.small.epics[0], ticket, f.small, new Map()),
    labels: [{ name: 'feature' }, { name: 'BUG' }, { name: 'custom' }],
  };
  const removed = [];
  const run = (args, input) => {
    if (args[1] === 'repos/student/movies')
      return JSON.stringify({ owner: { type: 'User' } });
    if (args[1].includes('/issues?')) return JSON.stringify([[existing]]);
    if (args[1].includes('/labels?'))
      return JSON.stringify([[{ name: 'feature' }]]);
    if (args.includes('DELETE')) {
      assert.equal(args[1], 'repos/student/movies/issues/1/labels/BUG');
      removed.push('BUG');
      existing.labels = existing.labels.filter((label) => label.name !== 'BUG');
      return '{}';
    }
    return f.run(args, input);
  };
  const options = { ...f.options, 'force-update': true };
  instantiate(f.small, options, run, () => {});
  instantiate(f.small, options, run, () => {});
  assert.deepEqual(removed, ['BUG']);
  assert.deepEqual(existing.labels, [{ name: 'feature' }, { name: 'custom' }]);
});

test('force-update surfaces field update failures without a success summary', () => {
  const f = fixture({ existing: true, failEdit: true });
  const output = [];
  assert.throws(
    () =>
      instantiate(
        f.small,
        { ...f.options, 'force-update': true },
        f.run,
        (line) => output.push(line),
      ),
    /Permission refusee/,
  );
  assert.ok(!output.some((line) => line.includes('tickets presents')));
});

test('apply creates issues and assigns Backlog, size, epic and priority', () => {
  const { small, calls, run, options } = fixture();
  instantiate(small, options, run, () => {});
  assert.equal(calls.filter(({ args }) => args.includes('POST')).length, 1);
  const creation = calls.find(({ args }) => args.includes('POST'));
  assert.equal(JSON.parse(creation.input).type, 'Feature');
  assert.ok(!Object.hasOwn(JSON.parse(creation.input), 'labels'));
  const edits = calls.filter(({ args }) => args[1] === 'item-edit');
  assert.equal(edits.length, 4);
  assert.ok(edits.some(({ args }) => args.includes('backlog')));
  assert.ok(edits.every(({ args }) => !args.includes('--number')));
  assert.ok(calls.some(({ input }) => input?.includes('updateProjectV2Field')));
});

test('resume preserves existing issues, estimates and workflow status', () => {
  const { small, calls, run, options } = fixture({ existing: true });
  instantiate(small, options, run, () => {});
  assert.equal(
    calls.filter(
      ({ args }) =>
        args.includes('POST') ||
        args[1] === 'item-edit' ||
        args[1] === 'item-add' ||
        args[1] === 'create',
    ).length,
    0,
  );
  assert.ok(
    !calls.some(({ input }) => input?.includes('updateProjectV2Field')),
  );
});

test('resume repairs missing fields after a partial run without resetting other values', () => {
  const { small, calls, run, options } = fixture({
    existing: true,
    missingSize: true,
  });
  instantiate(small, options, run, () => {});
  const edits = calls.filter(({ args }) => args[1] === 'item-edit');
  assert.equal(edits.length, 1);
  assert.ok(edits[0].args.includes('size'));
});

test('GitHub errors stop the import instead of reporting success', () => {
  const { small, run, options } = fixture({ failEdit: true });
  assert.throws(
    () => instantiate(small, options, run, () => {}),
    /Permission refusee/,
  );
});

test('new project receives all custom fields with their expected types', () => {
  const { small, run, options } = fixture();
  const created = new Map();
  function withoutCustomFields(args, input) {
    if (args[1] === 'field-create') {
      created.set(
        args[args.indexOf('--name') + 1],
        args[args.indexOf('--data-type') + 1],
      );
      return '';
    }
    const result = run(args, input);
    if (args[1] === 'field-list') {
      const data = JSON.parse(result);
      data.fields = data.fields.filter(
        (field) =>
          ['Title', 'Status'].includes(field.name) || created.has(field.name),
      );
      return JSON.stringify(data);
    }
    return result;
  }
  instantiate(small, options, withoutCustomFields, () => {});
  assert.deepEqual(
    [...created],
    [
      ['Size', 'SINGLE_SELECT'],
      ['Epic', 'SINGLE_SELECT'],
      ['Priority', 'SINGLE_SELECT'],
    ],
  );
});

test('existing scope field is reused regardless of capitalization', () => {
  const f = fixture({ existing: true, scope: 'frontend' });
  f.small.project.backlogColumns = ['Title', 'Epic', 'Size', 'scope', 'Status'];
  function capitalizedScope(args, input) {
    const result = f.run(args, input);
    if (args[1] !== 'field-list') return result;
    const data = JSON.parse(result);
    data.fields.find((field) => field.name === 'scope').name = 'Scope';
    return JSON.stringify(data);
  }
  instantiate(f.small, f.options, capitalizedScope, () => {});
  assert.ok(
    !f.calls.some(
      ({ args }) =>
        args[1] === 'field-create' &&
        args[args.indexOf('--name') + 1]?.toLowerCase() === 'scope',
    ),
  );
});

test('resume searches all issue pages and all project item pages', () => {
  const { small, calls, run, options } = fixture({ existing: true });
  let itemPages = 0;
  function paginated(args, input) {
    const result = run(args, input);
    if (args[0] === 'api' && args[1].includes('/issues?'))
      return JSON.stringify([[], ...JSON.parse(result)]);
    if (args[1] === 'graphql') {
      const payload = JSON.parse(input);
      if (payload.query.includes('items(first: 100')) {
        itemPages++;
        if (payload.variables.cursor === null) {
          return JSON.stringify({
            data: {
              node: {
                items: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: 'next' },
                },
              },
            },
          });
        }
        assert.equal(payload.variables.cursor, 'next');
      }
    }
    return result;
  }
  instantiate(small, options, paginated, () => {});
  assert.equal(itemPages, 2);
  assert.ok(
    !calls.some(
      ({ args }) =>
        args.includes('POST') ||
        args[1] === 'item-add' ||
        args[1] === 'item-edit',
    ),
  );
});

test('dependencies are created first and linked even when configuration order differs', () => {
  const { small, calls, run, options } = fixture();
  small.epics[0].tickets.unshift(
    structuredClone(
      config.epics.find((epic) => epic.id === 'WATCH').tickets[1],
    ),
  );
  let issueNumber = 0;
  function numbered(args, input) {
    const result = run(args, input);
    if (args.includes('POST'))
      return JSON.stringify({
        html_url: `https://github.com/student/movies/issues/${++issueNumber}`,
      });
    return result;
  }
  instantiate(small, options, numbered, () => {});
  const issues = calls
    .filter(({ args }) => args.includes('POST'))
    .map(({ input }) => JSON.parse(input));
  assert.ok(issues[0].title.startsWith('[WATCH-01]'));
  assert.ok(issues[1].title.startsWith('[WATCH-02]'));
  assert.ok(
    issues[1].body.includes('https://github.com/student/movies/issues/1'),
  );
});

test('duplicate issue markers stop the import before creating a project', () => {
  const { small, calls, run, options } = fixture({ existing: true });
  function duplicate(args, input) {
    const result = run(args, input);
    if (args[0] === 'api' && args[1].includes('/issues?'))
      return JSON.stringify([...JSON.parse(result), ...JSON.parse(result)]);
    return result;
  }
  assert.throws(
    () => instantiate(small, options, duplicate, () => {}),
    /Plusieurs issues/,
  );
  assert.ok(!calls.some(({ args }) => args[0] === 'project'));
});

test('legacy Weight fields are neither validated nor populated', () => {
  const { small, calls, run, options } = fixture({ existing: true });
  function incompatible(args, input) {
    const result = run(args, input);
    if (args[1] === 'field-list') {
      const data = JSON.parse(result);
      data.fields.push({ id: 'legacy-weight', name: 'Weight' });
      return JSON.stringify(data);
    }
    if (input && JSON.parse(input).query?.includes('dataType'))
      assert.fail('Legacy Weight field must not be validated');
    return result;
  }
  instantiate(small, options, incompatible, () => {});
  assert.ok(!calls.some(({ args }) => args.includes('legacy-weight')));
});

test('regeneration adds new tickets and epics once without changing existing work', () => {
  const { small, run, options } = fixture({ existing: true });
  small.epics[0].tickets.push({
    ...structuredClone(small.epics[0].tickets[0]),
    id: 'WATCH-04',
    title: 'Nouvelle fonctionnalite',
    dependsOn: ['WATCH-01'],
  });
  small.epics.push({
    id: 'NEW',
    title: 'Nouvelle idee',
    objective: 'Apprendre un nouveau concept.',
    tickets: [
      {
        ...structuredClone(small.epics[0].tickets[0]),
        id: 'NEW-01',
        title: 'Premier ticket de la nouvelle idee',
        dependsOn: ['WATCH-04'],
      },
    ],
  });
  const fields = JSON.parse(run(['project', 'field-list'])).fields;
  for (const field of fields) {
    if (field.options) {
      field.options = field.options.map((option) => ({
        ...option,
        color: 'BLUE',
        description: `Description ${option.name}`,
      }));
    }
  }
  const epic = fields.find((field) => field.name === 'Epic');
  epic.options.push({
    id: 'custom',
    name: 'CUSTOM',
    color: 'RED',
    description: 'Option de l equipe',
  });
  const originalOptions = structuredClone(epic.options);
  const existingItem = {
    id: 'original',
    content: { url: 'https://github.com/student/movies/issues/1' },
    fieldValues: {
      nodes: fields.map((field) => ({
        field: { name: field.name },
        name: 'Done',
        number: 8,
      })),
    },
  };
  const issues = [
    {
      number: 1,
      type: { name: 'Feature' },
      body: marker('WATCH-01'),
      html_url: existingItem.content.url,
    },
  ];
  const items = [existingItem];
  const mutations = [];
  const bodies = [];
  function evolving(args, input) {
    if (args[0] === 'api' && args[1].includes('/issues?'))
      return JSON.stringify([issues]);
    if (args[0] === 'api' && args.includes('POST')) {
      const issue = {
        ...JSON.parse(input),
        number: issues.length + 1,
        type: { name: JSON.parse(input).type },
        html_url: `https://github.com/student/movies/issues/${issues.length + 1}`,
      };
      issues.push(issue);
      bodies.push(issue);
      return JSON.stringify(issue);
    }
    if (args[1] === 'field-list') return JSON.stringify({ fields });
    if (args[1] === 'item-add') {
      const item = {
        id: `item-${items.length}`,
        content: { url: args[args.indexOf('--url') + 1] },
        fieldValues: { nodes: [] },
      };
      items.push(item);
      mutations.push({ type: 'add', id: item.id });
      return JSON.stringify(item);
    }
    if (args[1] === 'item-edit') {
      const item = items.find(
        (candidate) => candidate.id === args[args.indexOf('--id') + 1],
      );
      const field = fields.find(
        (candidate) => candidate.id === args[args.indexOf('--field-id') + 1],
      );
      item.fieldValues.nodes.push({ field: { name: field.name } });
      mutations.push({ type: 'edit', id: item.id });
      return '';
    }
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (variables.id === 'size') return run(args, input);
      if (/options\s*\{\s*id\s+name\s+color\s+description\s*\}/.test(query))
        return JSON.stringify({ data: { node: { options: epic.options } } });
      if (query.includes('updateProjectV2Field')) {
        assert.equal(variables.id, 'epic');
        assert.deepEqual(
          variables.options.slice(0, originalOptions.length),
          originalOptions,
        );
        epic.options = variables.options.map((option) => ({
          ...option,
          id: option.id ?? `new-${option.name}`,
        }));
        mutations.push({ type: 'options' });
        return JSON.stringify({ data: { updateProjectV2Field: {} } });
      }
      if (query.includes('items(first: 100'))
        return JSON.stringify({
          data: {
            node: { items: { nodes: items, pageInfo: { hasNextPage: false } } },
          },
        });
    }
    return run(args, input);
  }
  const originalItem = structuredClone(existingItem);
  instantiate(small, options, evolving, () => {});
  assert.equal(issues.length, 3);
  assert.equal(items.length, 3);
  assert.deepEqual(existingItem, originalItem);
  assert.ok(bodies[1].body.includes(issues[1].html_url));
  assert.ok(epic.options.some((option) => option.name === 'NEW'));
  assert.equal(
    mutations.filter((mutation) => mutation.type === 'edit').length,
    8,
  );
  const mutationCount = mutations.length;
  instantiate(small, options, evolving, () => {});
  assert.equal(issues.length, 3);
  assert.equal(items.length, 3);
  assert.equal(mutations.length, mutationCount);
  assert.deepEqual(existingItem, originalItem);
});

test('existing single-select fields with the wrong type are not replaced', () => {
  const { small, run, options } = fixture({ existing: true });
  function invalidSelect(args, input) {
    const result = run(args, input);
    if (args[1] === 'field-list') {
      const data = JSON.parse(result);
      delete data.fields.find((field) => field.name === 'Epic').options;
      return JSON.stringify(data);
    }
    return result;
  }
  assert.throws(
    () => instantiate(small, options, invalidSelect, () => {}),
    /SINGLE_SELECT/,
  );
});

test('explicit updates replace only title and body, resolve new dependencies and skip unchanged content', () => {
  const { small, run, options } = fixture({ existing: true });
  const existingTicket = small.epics[0].tickets[0];
  existingTicket.title = 'Titre revise';
  existingTicket.acceptance.push('Nouveau critere.');
  existingTicket.dependsOn = ['WATCH-04'];
  small.epics[0].tickets.push({
    ...structuredClone(existingTicket),
    id: 'WATCH-04',
    title: 'Nouvelle dependance',
    dependsOn: [],
  });
  const existing = {
    number: 1,
    title: 'Titre modifie manuellement',
    body: `${marker(existingTicket.id)}\nDescription et cases cochees`,
    html_url: 'https://github.com/student/movies/issues/1',
    state: 'closed',
    type: { name: 'Feature' },
  };
  const patches = [];
  function updating(args, input) {
    if (args[0] === 'api' && args[1].includes('/issues?'))
      return JSON.stringify([[existing]]);
    if (args.includes('PATCH')) {
      assert.equal(args[1], 'repos/student/movies/issues/1');
      const payload = JSON.parse(input);
      assert.deepEqual(Object.keys(payload).sort(), ['body', 'title']);
      Object.assign(existing, payload);
      patches.push(payload);
      return JSON.stringify(existing);
    }
    if (args.includes('POST'))
      return JSON.stringify({
        html_url: 'https://github.com/student/movies/issues/2',
      });
    if (args[1] === 'item-edit') {
      assert.notEqual(
        args[args.indexOf('--id') + 1],
        'item',
        'Existing project fields must remain intact',
      );
      return '';
    }
    if (args[1] === 'item-add') return JSON.stringify({ id: 'new-item' });
    return run(args, input);
  }
  const updateOptions = { ...options, 'update-existing': true };
  instantiate(small, updateOptions, updating, () => {});
  assert.equal(patches.length, 1);
  assert.equal(existing.title, '[WATCH-01] Titre revise');
  assert.ok(existing.body.includes('Nouveau critere.'));
  assert.ok(
    existing.body.includes('https://github.com/student/movies/issues/2'),
  );
  assert.equal(existing.state, 'closed');
  instantiate(small, updateOptions, updating, () => {});
  assert.equal(
    patches.length,
    1,
    'Identical contents must not be patched again',
  );
});

test('update simulation makes no GitHub calls and warns about manual edits', () => {
  const output = [];
  const options = parseOptions([
    '--repo',
    'movies',
    '--owner',
    'student',
    '--update-existing',
    '--dry-run',
  ]);
  instantiate(
    config,
    options,
    () => assert.fail('Unexpected GitHub call'),
    (line) => output.push(line),
  );
  assert.ok(output.some((line) => line.includes('modifications manuelles')));
});

test('update errors are surfaced without a success summary', () => {
  const { small, run, options } = fixture({ existing: true });
  const output = [];
  function denied(args, input) {
    if (args[0] === 'api' && args[1].includes('/issues?')) {
      return JSON.stringify([
        [
          {
            number: 1,
            type: { name: 'Feature' },
            body: marker('WATCH-01'),
            html_url: 'https://github.com/student/movies/issues/1',
          },
        ],
      ]);
    }
    if (args.includes('PATCH')) throw new Error('Modification refusee');
    return run(args, input);
  }
  assert.throws(
    () =>
      instantiate(
        small,
        { ...options, 'update-existing': true },
        denied,
        (line) => output.push(line),
      ),
    /Modification refusee/,
  );
  assert.ok(!output.some((line) => line.includes('tickets presents')));
});

test('configured tickets have supported types and invalid types are rejected', () => {
  assert.ok(
    config.epics
      .flatMap((epic) => epic.tickets)
      .every((ticket) => ['feature', 'bug'].includes(ticket.type)),
  );
  const invalid = structuredClone(config);
  invalid.epics[0].tickets[0].type = 'task';
  assert.throws(() => validateBacklog(invalid), /type attendu feature/);
});

test('rerun assigns native Feature to existing tickets without replacing other properties', () => {
  const { small, run, options } = fixture({ existing: true });
  const patches = [];
  function withoutType(args, input) {
    const result = args.includes('PATCH') ? '{}' : run(args, input);
    if (args[0] === 'api' && args[1].includes('/issues?')) {
      const pages = JSON.parse(result);
      delete pages[0][0].type;
      return JSON.stringify(pages);
    }
    if (args.includes('PATCH')) {
      assert.equal(args[1], 'repos/student/movies/issues/1');
      patches.push(JSON.parse(input));
    }
    return result;
  }
  instantiate(small, options, withoutType, () => {});
  assert.deepEqual(patches, [{ type: 'Feature' }]);
});

test('unknown owners and disabled organization types fail before creating anything', () => {
  for (const scenario of ['unknown', 'disabled']) {
    const { small, calls, run, options } = fixture();
    function unsupported(args, input) {
      const result = run(args, input);
      if (scenario === 'unknown' && args[1] === 'repos/student/movies')
        return JSON.stringify({ owner: { type: 'Unknown' } });
      if (scenario === 'disabled' && args[1] === 'orgs/student/issue-types')
        return JSON.stringify([{ name: 'Feature', is_enabled: false }]);
      return result;
    }
    assert.throws(
      () => instantiate(small, options, unsupported, () => {}),
      scenario === 'unknown' ? /inconnu/ : /Activer/,
    );
    assert.ok(
      !calls.some(
        ({ args }) =>
          args[0] === 'project' ||
          args.includes('POST') ||
          args.includes('PATCH'),
      ),
    );
  }
});

test('personal repositories use labels for creation and additive reruns, never native types', () => {
  for (const existing of [false, true]) {
    const { small, run, options } = fixture({ existing });
    const labels = [];
    const writes = [];
    const current = {
      number: 1,
      body: marker('WATCH-01'),
      html_url: 'https://github.com/student/movies/issues/1',
      labels: [{ name: 'student-label' }],
    };
    function personal(args, input) {
      if (args[1] === 'repos/student/movies' && !input)
        return JSON.stringify({ owner: { type: 'User' } });
      if (args[1] === 'orgs/student/issue-types')
        assert.fail('Personal repositories must not query organization types');
      if (args[1].includes('/labels?')) return JSON.stringify([[], labels]);
      if (args[0] === 'api' && args.includes('POST')) {
        const payload = JSON.parse(input);
        assert.ok(!Object.hasOwn(payload, 'type'));
        writes.push({ endpoint: args[1], payload });
        if (args[1] === 'repos/student/movies/labels') {
          labels.push({ name: payload.name });
          return '{}';
        }
        if (args[1].endsWith('/1/labels')) {
          current.labels.push({ name: 'feature' });
          return '{}';
        }
        return JSON.stringify({ html_url: current.html_url });
      }
      if (existing && args[1].includes('/issues?'))
        return JSON.stringify([[current]]);
      return run(args, input);
    }
    instantiate(small, options, personal, () => {});
    assert.equal(writes.length, 2);
    assert.equal(labels[0].name, 'feature');
    assert.deepEqual(writes[1].payload.labels, ['feature']);
    if (existing) {
      assert.equal(writes[1].endpoint, 'repos/student/movies/issues/1/labels');
      assert.ok(current.labels.some((label) => label.name === 'student-label'));
      instantiate(small, options, personal, () => {});
      assert.equal(
        writes.length,
        2,
        'Reruns must not recreate labels or relabel existing issues',
      );
    }
  }
});

test('existing feature labels are preserved regardless of case', () => {
  const { small, run, options } = fixture({ existing: true });
  function labeled(args, input) {
    if (args[1] === 'repos/student/movies')
      return JSON.stringify({ owner: { type: 'User' } });
    if (args[1].includes('/labels?'))
      return JSON.stringify([[{ name: 'Feature' }]]);
    if (args[1].includes('/issues?'))
      return JSON.stringify([
        [
          {
            number: 1,
            body: marker('WATCH-01'),
            html_url: 'https://github.com/student/movies/issues/1',
            labels: [{ name: 'Feature' }],
          },
        ],
      ]);
    assert.ok(!args.includes('POST') && !args.includes('PATCH'));
    return run(args, input);
  }
  instantiate(small, options, labeled, () => {});
});

test('default view is renamed to configured Backlog once, without altering its layout', () => {
  const { small, run, options } = fixture({ existing: true });
  const view = {
    id: 'view',
    name: 'View 1',
    number: 1,
    sortByFields: titleSort(),
  };
  const updates = [];
  function withDefaultView(args, input) {
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (query.includes('visibleFields(first: 100)')) return run(args, input);
      if (query.includes('views(first: 100'))
        return JSON.stringify({
          data: {
            node: {
              views: {
                nodes: [
                  view,
                  ...(view.name === 'Backlog'
                    ? JSON.parse(run(args, input)).data.node.views.nodes.filter(
                        (candidate) => candidate.name !== 'Backlog',
                      )
                    : []),
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      if (
        query.includes('updateProjectV2View') &&
        variables.name !== undefined
      ) {
        assert.deepEqual(variables, { id: 'view', name: 'Backlog' });
        assert.ok(!query.includes('layout:'));
        view.name = variables.name;
        updates.push(variables);
        return JSON.stringify({
          data: { updateProjectV2View: { projectV2View: view } },
        });
      }
    }
    return run(args, input);
  }
  instantiate(small, options, withDefaultView, () => {});
  instantiate(small, options, withDefaultView, () => {});
  assert.equal(updates.length, 1);
});

test('custom views are preserved and only the missing Backlog view is created', () => {
  const { small, run, options } = fixture({ existing: true });
  const views = [
    { id: 'custom', name: 'Sprint actuel', number: 1 },
    { id: 'legacy-epics', name: 'Epics', number: 2 },
  ];
  const original = structuredClone(views);
  const createdNames = [];
  function withCustomView(args, input) {
    if (args[1].endsWith('/views')) {
      const payload = JSON.parse(input);
      assert.equal(payload.name, 'Backlog');
      assert.equal(payload.layout, 'table');
      const view = {
        id: 'new-view',
        name: payload.name,
        number: 3,
        sortByFields: titleSort(),
      };
      views.push(view);
      createdNames.push(payload.name);
      return JSON.stringify({
        node_id: view.id,
        name: view.name,
        sort_by: payload.sort_by,
      });
    }
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (query.includes('visibleFields(first: 100)')) return run(args, input);
      if (query.includes('views(first: 100'))
        return JSON.stringify({
          data: {
            node: {
              views: {
                nodes: [
                  ...views,
                  ...JSON.parse(run(args, input)).data.node.views.nodes.filter(
                    (candidate) => candidate.name !== 'Backlog',
                  ),
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });

      assert.ok(!query.includes('updateProjectV2View'));
      if (query.includes('createProjectV2View')) {
        assert.equal(variables.name, 'Backlog');
        assert.ok(query.includes('TABLE_LAYOUT'));
        const view = { id: 'new-view', name: variables.name, number: 2 };
        views.push(view);
        createdNames.push(variables.name);
        return JSON.stringify({
          data: { createProjectV2View: { projectV2View: view } },
        });
      }
    }
    return run(args, input);
  }
  instantiate(small, options, withCustomView, () => {});
  instantiate(small, options, withCustomView, () => {});
  assert.deepEqual(views.slice(0, 2), original);
  assert.deepEqual(createdNames, ['Backlog']);
});

test('Epic and Size follow Title while other columns keep their relative order', () => {
  const { small, run, options } = fixture({ existing: true });
  const columns = [{ id: 'title' }, { id: 'status' }, { id: 'custom-column' }];
  let updates = 0;
  function visible(args, input) {
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (query.includes('visibleFields(first: 100)'))
        return JSON.stringify({
          data: {
            node: {
              views: {
                nodes: [
                  ...JSON.parse(run(args, input)).data.node.views.nodes.filter(
                    (candidate) => candidate.name !== 'Backlog',
                  ),
                  {
                    id: 'view',
                    name: 'Backlog',
                    configuration: { visibleFields: { nodes: columns } },
                  },
                ],
              },
            },
          },
        });

      if (query.includes('visibleFieldIds:')) {
        assert.deepEqual(variables.fields, [
          'title',
          'epic',
          'size',
          'status',
          'custom-column',
        ]);
        columns.splice(
          0,
          columns.length,
          ...variables.fields.map((id) => ({ id })),
        );
        updates++;
        return JSON.stringify({
          data: { updateProjectV2View: { projectV2View: { id: 'view' } } },
        });
      }
    }
    return run(args, input);
  }
  instantiate(small, options, visible, () => {});
  instantiate(small, options, visible, () => {});
  assert.equal(updates, 1);
});

test('Size palette preserves option IDs, descriptions and custom options and applies only once', () => {
  const { small, run, options } = fixture({ existing: true });
  let sizeOptions = [
    ...small.sizes.map((size) => ({
      id: `id-${size.name}`,
      name: size.name,
      color: 'GRAY',
      description: `Details ${size.name}`,
    })),
    {
      id: 'custom',
      name: 'Unestimated',
      color: 'PURPLE',
      description: 'Equipe',
    },
  ];
  const original = structuredClone(sizeOptions);
  let changes = 0;
  function colors(args, input) {
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (variables.id === 'size') {
        if (query.includes('updateProjectV2Field')) {
          sizeOptions = variables.options;
          changes++;
          return JSON.stringify({ data: { updateProjectV2Field: {} } });
        }
        return JSON.stringify({ data: { node: { options: sizeOptions } } });
      }
    }
    return run(args, input);
  }
  instantiate(small, options, colors, () => {});
  instantiate(small, options, colors, () => {});
  assert.equal(changes, 1);
  for (const size of small.sizes)
    assert.equal(
      sizeOptions.find((option) => option.name === size.name).color,
      size.color,
    );
  assert.deepEqual(
    sizeOptions.map(({ id, name, description }) => ({ id, name, description })),
    original.map(({ id, name, description }) => ({ id, name, description })),
  );
  assert.deepEqual(sizeOptions.at(-1), original.at(-1));
});

test('Priority and Epic palettes preserve identities, custom colors and rerun without writes', () => {
  const { small, run, options } = fixture({ existing: true });
  const palettes = {
    priority: ['P1', 'P2', 'P3', 'custom'].map((name) => ({
      id: `priority-${name}`,
      name,
      color: 'GRAY',
      description: name,
    })),
    epic: ['DASHBOARD', 'EXP', 'COMP', 'custom'].map((name) => ({
      id: `epic-${name}`,
      name,
      color: name === 'COMP' || name === 'custom' ? 'PINK' : 'GRAY',
      description: name,
    })),
  };
  const original = structuredClone(palettes);
  let changes = 0;
  function colors(args, input) {
    if (args[1] === 'graphql') {
      const { query, variables } = JSON.parse(input);
      if (palettes[variables.id]) {
        if (query.includes('updateProjectV2Field')) {
          palettes[variables.id] = variables.options;
          changes++;
          return JSON.stringify({ data: { updateProjectV2Field: {} } });
        }
        return JSON.stringify({
          data: { node: { options: palettes[variables.id] } },
        });
      }
    }
    return run(args, input);
  }
  instantiate(small, options, colors, () => {});
  instantiate(small, options, colors, () => {});
  assert.equal(changes, 2);
  assert.deepEqual(
    palettes.priority.map((o) => o.color),
    ['RED', 'ORANGE', 'YELLOW', 'GRAY'],
  );
  assert.deepEqual(
    palettes.epic.map((o) => o.color),
    ['BLUE', 'GREEN', 'PINK', 'PINK'],
  );
  for (const id of ['priority', 'epic'])
    assert.deepEqual(
      palettes[id].map(({ color: _color, ...option }) => option),
      original[id].map(({ color: _color, ...option }) => option),
    );
});

test('bug tickets require reproduction and render steps in the issue body', () => {
  const epic = config.epics.find((candidate) => candidate.id === 'BUG');
  assert.equal(epic.tickets.length, 3);
  for (const ticket of epic.tickets) {
    assert.equal(ticket.type, 'bug');
    const body = issueBody(epic, ticket, config, new Map());
    assert.ok(body.includes('## Reproduction'));
    assert.ok(body.includes(`1. ${ticket.reproduction[0]}`));
  }
  const invalid = structuredClone(config);
  delete invalid.epics.find((candidate) => candidate.id === 'BUG').tickets[0]
    .reproduction;
  assert.throws(() => validateBacklog(invalid), /reproduction/);
});

test('mixed feature and bug tickets receive native types or personal labels', () => {
  for (const personalRepo of [false, true]) {
    const { small, run, options } = fixture();
    small.epics[0].tickets.push({
      ...structuredClone(small.epics[0].tickets[0]),
      id: 'WATCH-04',
      type: 'bug',
      reproduction: ['Simuler une erreur puis observer le defaut.'],
    });
    const creations = [];
    const labelCreations = [];
    function mixed(args, input) {
      if (personalRepo && args[1] === 'repos/student/movies')
        return JSON.stringify({ owner: { type: 'User' } });
      if (args[1].includes('/labels?')) return JSON.stringify([[]]);
      if (args.includes('POST')) {
        const payload = JSON.parse(input);
        if (args[1].endsWith('/labels')) {
          labelCreations.push(payload.name);
          return '{}';
        }
        creations.push(payload);
        return JSON.stringify({
          html_url: `https://github.com/student/movies/issues/${creations.length}`,
        });
      }
      return run(args, input);
    }
    instantiate(small, options, mixed, () => {});
    assert.equal(creations.length, 2);
    assert.ok(creations[1].body.includes('## Reproduction'));
    if (personalRepo) {
      assert.deepEqual(labelCreations, ['feature', 'bug']);
      assert.deepEqual(
        creations.map((issue) => issue.labels),
        [['feature'], ['bug']],
      );
      assert.ok(creations.every((issue) => !Object.hasOwn(issue, 'type')));
    } else {
      assert.deepEqual(
        creations.map((issue) => issue.type),
        ['Feature', 'Bug'],
      );
    }
  }
});

test('Features and Bugs views are created and filtered once for each repository kind', () => {
  for (const personalRepo of [false, true]) {
    const { small, run, options } = fixture({ existing: true });
    const views = [
      {
        id: 'view',
        name: 'Backlog',
        number: 1,
        filter: '',
        sortByFields: titleSort(),
      },
    ];
    const filters = [];
    let creations = 0;
    function filtered(args, input) {
      if (args[1].endsWith('/views')) {
        const payload = JSON.parse(input);
        const view = {
          id: payload.name,
          name: payload.name,
          number: views.length + 1,
          filter: '',
          sortByFields: titleSort(),
        };
        views.push(view);
        creations++;
        return JSON.stringify({
          node_id: view.id,
          name: view.name,
          sort_by: payload.sort_by,
        });
      }
      if (personalRepo && args[1] === 'repos/student/movies')
        return JSON.stringify({ owner: { type: 'User' } });
      if (args[1].includes('/labels?'))
        return JSON.stringify([[{ name: 'feature' }]]);
      if (personalRepo && args[1].includes('/issues?'))
        return JSON.stringify([
          [
            {
              number: 1,
              body: marker('WATCH-01'),
              html_url: 'https://github.com/student/movies/issues/1',
              labels: [{ name: 'feature' }],
            },
          ],
        ]);
      if (args[1] === 'graphql') {
        const { query, variables } = JSON.parse(input);
        if (query.includes('views(first: 100'))
          return JSON.stringify({
            data: {
              node: {
                views: {
                  nodes: views.map((view) => ({
                    ...view,
                    configuration: {
                      visibleFields: {
                        nodes: [
                          { id: 'title' },
                          { id: 'epic' },
                          { id: 'size' },
                        ],
                      },
                    },
                  })),
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          });
        if (query.includes('createProjectV2View')) {
          const view = {
            id: variables.name,
            name: variables.name,
            number: views.length + 1,
            filter: '',
          };
          views.push(view);
          creations++;
          return JSON.stringify({
            data: { createProjectV2View: { projectV2View: view } },
          });
        }
        if (query.includes('updateProjectV2View')) {
          const view = views.find((candidate) => candidate.id === variables.id);
          assert.ok(view && view.name !== 'Backlog');
          view.filter = variables.filter;
          filters.push(variables.filter);
          return JSON.stringify({
            data: { updateProjectV2View: { projectV2View: view } },
          });
        }
      }
      return run(args, input);
    }
    instantiate(small, options, filtered, () => {});
    instantiate(small, options, filtered, () => {});
    assert.equal(creations, 2);
    assert.deepEqual(
      views
        .slice(1)
        .map((view) => view.name)
        .sort(),
      ['Bugs', 'Features'],
    );
    assert.deepEqual(
      filters,
      personalRepo
        ? ['label:feature', 'label:bug']
        : ['type:Feature', 'type:Bug'],
    );
    assert.equal(views[0].filter, '');
  }
});
