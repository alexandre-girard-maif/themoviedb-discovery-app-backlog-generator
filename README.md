# Générateur de backlog TMDB

Ce dépôt contient le générateur de backlog pédagogique pour les projets
[TMDB des étudiants de BUT Science des données](https://github.com/but-sd/themoviedb-discovery-app-demo-2).
Il est indépendant de l'application : il crée les issues et configure un
GitHub Project dans le dépôt cible explicitement choisi.

## Utiliser le projet avec GitHub Codespaces

Pour travailler sur votre propre copie, ouvrez la page GitHub de ce dépôt et
cliquez sur **Fork**. Une fois le fork créé dans votre compte ou votre
organisation, ouvrez-le, puis choisissez **Code > Codespaces > Create codespace
on [branche]**. Le Codespace s'ouvre directement sur votre fork.

Le Codespace configure Node.js 24 et installe les dépendances à sa création.
Dans le terminal, passer les commandes suivante:

```sh
# Vérifier le mode d’authentification
gh auth status

# Ne plus utiliser le jeton automatique du Codespace dans ce terminal
unset GH_TOKEN GITHUB_TOKEN

# S’authentifier avec ton compte et les droits Projects
gh auth login --hostname github.com --web --scopes project
```

Le projet requiert Node.js 24 ou supérieur (voir `.nvmrc`). Si les dépendances
changent après la création du Codespace, exécutez `npm ci`. Le jeton doit
permettre de créer des issues et un GitHub Project. Si votre authentification
le permet, ajoutez l'accès aux Projects avec
`gh auth refresh -s project`. Les droits du Codespace et les règles de
l'organisation cible peuvent limiter ces opérations.

Le fork sert de copie du générateur : `--repo` désigne uniquement le nom du
dépôt cible. Sans `--owner`, le générateur utilise le login authentifié par
`gh` comme propriétaire ; ajoutez `--owner ORGANISATION` pour une cible dans
une organisation. Les issues et le GitHub Project doivent appartenir au même
propriétaire ; le fork du générateur n'est pas la cible, sauf si vous souhaitez
réellement y créer le backlog. Remplacez `MON_DEPOT`, puis lancez d'abord une
simulation et l'import :

```sh
npm run backlog:instantiate -- --repo themoviedb-discovery-app --dry-run
npm run backlog:instantiate -- --repo themoviedb-discovery-app --apply
```

Par défaut, `--apply` synchronise des **brouillons GitHub Projects** sans créer
d'issues. Leur identité repose sur les clés stables du YAML. La création
d'issues doit être demandée explicitement avec `--create-issues --apply`.
`--prune` nécessite aussi `--create-issues` ; il ne supprime pas les brouillons.

Les vues **Backlog backend** et **Backlog frontend** sont configurées lorsque
le champ `Scope` existe. Elles filtrent les tickets par périmètre, avec les
mêmes colonnes que Backlog, en mode brouillons comme en mode issues.

`--dry-run` ne contacte pas GitHub. Vérifiez soigneusement le dépôt indiqué
avant d'utiliser `--apply`, qui applique la configuration au projet GitHub et
peut créer un projet ou des tickets selon les options. Sans
`--project-number`, le script réutilise le projet ouvert dont le titre
correspond au backlog et au dépôt, s'il existe ; sinon il le crée. Pour choisir
un autre projet sans ambiguïté, ajoutez `--project-number NUMERO`.

## Installation et utilisation

Cloner ce dépôt, puis exécuter les commandes depuis son répertoire :

```sh
git clone https://github.com/but-sd/themoviedb-discovery-app-backlog-generator.git
cd themoviedb-discovery-app-backlog-generator
npm ci
npm run backlog:instantiate -- --repo MON_DEPOT --dry-run
npm run backlog:instantiate -- --repo MON_DEPOT --apply
```

Node.js 24 ou supérieur et le CLI GitHub `gh` authentifié avec les droits sur
les issues et Projects sont requis. Ne pas cibler ce dépôt de générateur pour
instancier les tickets de l'application. `--repo` accepte uniquement le nom
du dépôt. Sans `--owner`, le login authentifié par `gh` est utilisé ; fournir
`--owner ORGANISATION` pour une cible d'organisation. Le dépôt cible et le
GitHub Project doivent appartenir au même propriétaire.

## Configuration et reprise

Le [backlog YAML](.github/backlog/backlog.yaml) contient 15 tickets Feature,
leurs critères, dépendances, tailles de T-shirt et le milestone **1.1.0**.
Le [guide complet](.github/backlog/README.md) explique l'atelier agile,
les droits GitHub, les vues, les milestones et les clés stables.
Les liens vers les PR de référence restent ceux de l'application.

Pour reprendre le même projet, conserver son numéro :

```sh
npm run backlog:instantiate -- --repo MON_DEPOT --project-number NUMERO --apply
```

Sans numéro, `--apply` recherche un projet ouvert portant le titre généré pour
le backlog et le dépôt, puis le réutilise ; s'il n'en trouve pas, il crée le
projet. Si plusieurs projets portent ce titre, préciser `--project-number`.
Les relances ne dupliquent pas les issues et conservent leur avancement.
L'option `--update-existing` remplace explicitement les titres et descriptions
des issues existantes, y compris les modifications manuelles, mais conserve
les commentaires et champs déjà renseignés.
`--config chemin/backlog.yaml` permet de fournir une autre configuration.
La simulation sans `--prune` est locale et n'effectue aucun appel GitHub.

Pour prendre le YAML comme référence et remplacer les valeurs déjà renseignées :

```sh
npm run backlog:instantiate -- --repo themoviedb-discovery-app --force-update --apply
```

`--force-update` synchronise les titres, descriptions, Size, Priority, Epic,
scope déclaré et, en mode issues, le milestone déclaré et le type Feature/Bug.
Il conserve le statut, les valeurs absentes du YAML, les champs non gérés et
les commentaires. Il fonctionne avec les brouillons et les issues ; il ne
crée pas d'issues sans `--create-issues`. Sans cette option, les champs déjà
renseignés restent conservés. `--force-update --dry-run` reste local et avertit
des remplacements, sans comparer les valeurs présentes sur GitHub.

Pour nettoyer les issues générées retirées du YAML, utiliser `--prune` avec
`--project-number NUMERO`. Avec `--dry-run`, cette option consulte GitHub sans
écriture et affiche les issues concernées. Avec `--apply`, elle les ferme et
les retire du projet ciblé, sans suppression définitive. Les issues manuelles
et celles hors du projet sont conservées.

L'extraction depuis l'application ne déplace ni ne supprime les issues et
Projects existants. Pour mettre à jour le projet pédagogique de référence :

```sh
npm run backlog:instantiate -- --repo themoviedb-discovery-app-demo-2 --owner but-sd --project-number 8 --update-existing --apply
```

## Développement

```sh
npm test
npm run lint
npm run fmt:check
```

Les tests utilisent un CLI GitHub simulé et n'écrivent rien sur GitHub.
La CI exécute les mêmes vérifications.
