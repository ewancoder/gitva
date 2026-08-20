/** Russian translation of Gitva. */

import type { Strings } from './strings.js';

const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11
    ? one
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
      ? few
      : many;

const commits = (n: number) => plural(n, 'коммит', 'коммита', 'коммитов');
const objects = (n: number) => plural(n, 'объект', 'объекта', 'объектов');

export const ru: Strings = {
  ui: {
    'recording-id.title': 'Уникальный ID записи репозитория. Нажмите, чтобы скопировать: `gitva --id ID` подхватит ту же запись откуда угодно',
    'question.title': 'фильтр объектов',
    'question.all': 'всё',
    'question.branches': 'ветки…',
    'question.message': 'поиск: сообщение',
    'question.author': 'поиск: автор',
    'question.path': 'поиск: путь',
    'question.content': 'поиск: содержимое',
    'search.placeholder': 'поиск',

    'load-all': 'загрузить все коммиты',
    'load-all.title': 'Загрузить всю историю коммитов',
    'expand-all': 'развернуть всё',
    'expand-all.title': 'Развернуть каждый коммит и дерево (двойной щелчок по коммиту или дереву разворачивает и сворачивает его)',
    'collapse-all': 'свернуть всё',
    'collapse-all.title': 'Свернуть все коммиты (деревья всегда остаются развёрнутыми)',
    index: 'индекс',
    'index.title': 'Показывать индекс справа',
    unreachable: 'недостижимые',
    'unreachable.title': 'Показывать недостижимые объекты',
    'cross-links': 'связи от недостижимых',
    'cross-links.title': 'Показывать связи от недостижимых объектов к достижимым',
    help: 'справка',
    settings: 'настройки',

    'reset-view': 'сбросить вид',
    'reset-view.title':
      'Вернуть всё, что вы перетащили, и все расширенные столбцы в дефолтное положение',
    'step-back.title': 'Предыдущий шаг',
    'pause.title': 'Приостановить авто-переход на новый шаг',
    'step-forward.title': 'Следующий шаг',

    'help.title': 'что на экране',
    'help.lede': 'Живой граф объектов репозитория.',
    'help.legend.commit': 'коммит',
    'help.legend.tree': 'дерево',
    'help.legend.blob': 'блоб',
    'help.legend.staged': 'проиндексированный блоб',
    'help.legend.ref': 'ссылка / HEAD',
    'help.legend.tag': 'аннотированный тег',
    'help.legend.index': 'запись индекса',
    'help.legend.unreachable': 'недостижимый обьект',
    'help.legend.changed': 'только что изменилось',
    'help.keyboard': 'клавиатура',
    'help.keys.wheel': 'колесо мыши',
    'help.keys.wheel.does': 'прокрутка вверх и вниз · с <kbd>ctrl</kbd> — масштаб',
    'help.keys.dragBackground': 'таскать за экран',
    'help.keys.dragBackground.does': 'сдвинуть холст',
    'help.keys.doubleBackground': 'двойной щелчок по экрану',
    'help.keys.doubleBackground.does': 'вписать холст по ширине',
    'help.keys.click': 'щелчок',
    'help.keys.click.does': 'показать, что это за обьект, и скопировать его sha',
    'help.keys.rightClick': 'щелчок правой клавишей',
    'help.keys.rightClick.does': 'отметить, чтобы следить за ним, пока граф объектов двигается',
    'help.keys.doubleCommit': 'двойной щелчок по коммиту',
    'help.keys.doubleCommit.does': 'развернуть или свернуть — показать, на что ссылается этот коммит',
    'help.keys.doubleTree': 'двойной щелчок по дереву',
    'help.keys.doubleTree.does': 'развернуть или свернуть это дерево (то, на что оно ссылается)',
    'help.keys.drag': 'перетащить что угодно',
    'help.keys.drag.does': 'закрепить в другом месте («сбросить вид» снимает все закрепления)',
    'help.keys.shiftClick': 'shift-щелчок по нему',
    'help.keys.shiftClick.does': 'снять закрепление одного обьекта',
    'help.keys.seam': 'перетащить границу столбца',
    'help.keys.seam.does': 'расширить этот столбец («сбросить вид» вернёт его назад)',
    'help.keys.fit.does': 'вписать холст по ширине (изменить масштаб)',
    'help.keys.index.does': 'показать или скрыть индекс',
    'help.keys.back.does': 'шаг назад по записи',
    'help.keys.forward.does': 'шаг вперёд по записи',
    'help.keys.space.does': 'пауза или к живой записи',
    close: 'закрыть',

    'settings.title': 'настройки',
    'settings.lede':
      'Личные настройки просмотра.',
    'settings.centreOnClick': 'щелчок по чему-нибудь центрирует вид на нём',
    'settings.refitOnChange': 'авто-масштабирование, когда в репозитории что-то происходит',
    'settings.showPins': 'показать булавку на всём, что вы передвинули вручную',
    'settings.openNewCommits': 'новые коммиты сразу развёрнуты',
  },

  canvas: {
    bands: {
      pointers: 'указатели и теги',
      commits: 'коммиты',
      objects: 'деревья и блобы',
      index: 'индекс',
    },
    tagPrefix: 'тег: ',
    heldBack: (entries: number) => `дерево +${entries}`,
    more: {
      label: 'загрузить ещё историю',
      of: (shown: number, total: number) => `${shown} из ${total} ${commits(total)}`,
      shown: (shown: number) => `показано: ${shown} ${commits(shown)}`,
    },
  },

  status: {
    live: 'живая запись',
    paused: 'на паузе',
    connecting: 'подключение',
    lost: 'соединение потеряно',
    pause: 'пауза',
    goLive: 'к живой записи',
    copied: (what: string) => `скопировано: ${what}`,
    tally: (
      drawn: number,
      commits_: number,
      counts: { commit: number; tree: number; blob: number; tag: number },
      unreachable: number,
      index: number,
    ) =>
      `${drawn} на экране · ${commits_} ${commits(commits_)}` +
      ` · ${counts.commit}c ${counts.tree}t ${counts.blob}b${counts.tag ? ` ${counts.tag}g` : ''}` +
      ` · недостижимых обьектов ${unreachable} · в индексе ${index}`,
    tallyBig: (drawn: number, commits_: number, objs: number, index: number) =>
      `${drawn} на экране · ${commits_} ${commits(commits_)} · ${objs.toLocaleString()} ${objects(objs)} · в индексе ${index}`,
    stepsDropped: (kept: number, dropped: number) =>
      `Запись: сохранено шагов — ${kept}, отброшено более старых — ${dropped}.`,
  },

  change: {
    first: 'изначальная загрузка',
    none: 'видимых изменений нет',
    join: ', ',
    /** Тип приходит от git как есть: blob, tree, commit, tag. */
    kind: (n: number, type: string) =>
      `${n} ` +
      (type === 'commit'
        ? commits(n)
        : type === 'tree'
          ? plural(n, 'дерево', 'дерева', 'деревьев')
          : type === 'blob'
            ? plural(n, 'блоб', 'блоба', 'блобов')
            : type === 'tag'
              ? plural(n, 'тег', 'тега', 'тегов')
              : objects(n)),
    added: (kinds: string) => `+${kinds}`,
    gone: (n: number) => `-${n} ${objects(n)}`,
    newRef: (name: string) => `новая ссылка ${name}`,
    refMoved: (name: string, sha: string) => `${name} → ${sha}`,
    refDeleted: (name: string) => `удалена ссылка ${name}`,
    headTo: (name: string) => `HEAD → ${name}`,
    headDetached: 'отделён',
    headMoved: 'HEAD переместился',
    staged: (n: number) => `+${n} ${plural(n, 'запись', 'записи', 'записей')} индекса`,
    unstaged: (n: number) => `-${n} ${plural(n, 'запись', 'записи', 'записей')} индекса`,
    nowUnreachable: (n: number) => `теперь недостижимо: ${n}`,
  },

  notes: {
    noUnreachableDetection: (objs: number) =>
      `Поиск недостижимых объектов отключён: репозиторий слишком большой — ${objs.toLocaleString()} ${objects(objs)}`,
    treesOnDemand: 'Деревья загружаются только для тех коммитов, которые вы развернули',
    indexElided: (shown: number, total: number) =>
      `Индекс: показаны только записи, отличающиеся от HEAD — ${shown} из ${total} проиндексированных путей.`,
    more: (shown: number) =>
      `Показано ${shown} ${commits(shown)} — нажмите «загрузить ещё историю», чтобы увидеть остальные.`,
    refsOutside: (n: number) =>
      `${n} ${plural(n, 'ссылка указывает', 'ссылки указывают', 'ссылок указывают')} за пределы этого окна и ${plural(n, 'не показана', 'не показаны', 'не показаны')}.`,
    indexHidden: 'Индекс скрыт.',
    unreachableHidden:
      'Недостижимые объекты скрыты — они по-прежнему в базе данных объектов.',
    noCommitGraph:
      'В этом репозитории нет commit-graph. `git commit-graph write --reachable` сильно ускорил бы обход истории — gitva не запишет его за вас.',
    looseObjects: (loose: number) =>
      `${loose.toLocaleString()} ${plural(loose, 'объект не упакован', 'объекта не упакованы', 'объектов не упаковано')}. \`git gc\` упаковал бы их — gitva не запустит его за вас.`,
    bodiesOnSelection:
      'Содержимое объектов загружается, когда вы что-нибудь выбираете.',
  },

  inspector: {
    empty: 'Щёлкните по чему угодно, чтобы узнать, что это.',
    reading: 'чтение…',
    unreadable: 'не удалось прочитать',
    unexplained: 'Пояснение для этого ещё не написано.',
    heading: {
      entries: 'записи',
      object: 'объект как есть',
      contents: 'содержимое',
      raw: 'содержимое как есть',
    },
    notText: (size: number) => `${size} ${plural(size, 'байт', 'байта', 'байт')}, не текст.`,
    truncated: (size: number) => `… первые 64 КиБ из ${size} ${plural(size, 'байта', 'байтов', 'байтов')}.`,
    size: {
      bytes: (n: number) => `${n} Б`,
      kib: (n: string) => `${n} КиБ`,
    },

    fields: {
      sha: 'sha',
      size: 'размер',
      reachable: 'достижим',
      tree: 'дерево',
      parents: 'родители',
      author: 'автор',
      authored: 'создано',
      message: 'сообщение',
      entries: 'записи',
      tagName: 'имя тега',
      pointsAt: 'указывает на',
      tagger: 'автор тега',
      name: 'имя',
      file: 'файл',
      contains: 'содержит',
      peelsTo: 'в итоге указывает на',
      resolvesTo: 'разрешается в',
      stored: 'хранится',
      path: 'путь',
      blob: 'блоб',
      mode: 'режим доступа',
      stage: 'stage',
    },

    values: {
      unreachable:
        'нет — на него ничто не указывает. Он всё ещё в базе данных объектов, и его можно вернуть по имени, пока git gc его не удалил.',
      stagedOnly:
        'только через индекс — ни один коммит его пока не называет. git gc хранит его, пока он проиндексирован, а снятие с индекса делает его недостижимым.',
      noParents: 'нет (корневой)',
      // По-английски здесь стоит собственное слово git — «folded into
      // .git/packed-refs». В русском git такого глагола нет, поэтому просто
      // «перенесена».
      packed: 'упакована — перенесена в .git/packed-refs, так что самого файла больше нет',
      loose: 'loose — настоящий файл на диске',
      unborn: (ref: string) =>
        `ref: ${ref} — которого ещё нет. Ещё не начавшаяся ветка: HEAD называет файл, который появится с первым коммитом.`,
      detached: (oid: string) => `${oid} — отделён, чистый sha без ветки посередине`,
      headRef: (ref: string) => `ref: ${ref}`,
      pointsAt: (type: string, oid: string) => `${type} ${oid}`,
      conflictStage: (stage: number) =>
        `${stage} — запись конфликта (1 = общий предок, 2 = наша версия, 3 = их версия). Разрешение конфликта пишет вместо них одну чистую запись stage 0.`,
    },

    kinds: {
      blob: {
        title: 'Блоб',
        what: 'Блоб (англ. blob) — это содержимое файла и больше ничего: ни имени, ни пути, ни даты, ни прав. Два файла с одинаковым содержимым в любом месте истории — это один и тот же блоб, сохранённый однажды. Имя, под которым вы знаете файл, живёт в дереве, которое указывает сюда.',
        made: 'git hash-object -w <file>',
      },
      tree: {
        title: 'Дерево',
        what: 'Дерево — это один каталог: отсортированный список имён, у каждого режим доступа и sha того, что оно держит, — блоб для файла, другое дерево для подкаталога. Имена живут в деревьях. Это всё, что git делает, чтобы сохранить каталог.',
        made: 'git write-tree  (из индекса) или git mktree',
      },
      commit: {
        title: 'Коммит',
        what: 'Коммит — это крошечный текстовый объект: sha одного дерева — всего проекта на тот момент — плюс sha его родителей, автор, коммитер и сообщение. Никаких изменений он не хранит. Список изменений git вычисляет по требованию, сравнивая два дерева.',
        made: 'git commit-tree <tree> -p <parent>',
      },
      tag: {
        title: 'Аннотированный тег',
        what: 'Аннотированный тег — настоящий объект: имя, tagger — кто его поставил, — сообщение и sha того, на что он указывает. Это почти указатель, к которому прилагается история, — поэтому здесь он стоит с указателями, а не с объектами.',
        made: 'git mktag  /  git tag -a <name>',
      },
      ref: {
        title: 'Ссылка',
        what: 'Ссылка — это файл, в котором лежит sha. В этом весь механизм. Ветка — ссылка в refs/heads, которую перезаписывают при каждом коммите; неаннотированный тег — ссылка в refs/tags, которую не перезаписывают. Ничто в ветке не является полноценным объектом.',
        made: 'git update-ref refs/heads/<name> <sha>',
      },
      head: {
        title: 'HEAD',
        what: 'HEAD — это файл с текстом «ref: refs/heads/<branch>», то есть указатель на указатель. Именно эта косвенность заставляет коммит двигать ветку. Отделите его — и HEAD держит чистый sha, поэтому сделанные там коммиты так легко потерять.',
        made: 'git symbolic-ref HEAD refs/heads/<name>',
      },
      index: {
        title: 'Запись индекса',
        what: 'Индекс — это один двоичный файл со списком путей, которые войдут в следующий коммит, у каждого sha блоба и режим доступа. Это единственное место, где существует наполовину проиндексированное изменение: ни в рабочем каталоге, ни в каком объекте. Индексация пишет сюда; коммит превращает это в дерево.',
        made: 'git update-index --add <path>',
      },
      more: {
        title: 'Загрузить ещё историю',
        what: 'У этих коммитов есть настоящие родители, но они за пределами окна, которое запросила gitva. Связь честно нарисована сюда, а не в объект, которого нет на экране. Нажмите этот блок, чтобы загрузить остальную историю.',
        made: 'git rev-list -n <more>',
      },
    },
  },

  language: {
    switchTo: (name: string) => `Язык интерфейса: ${name}`,
  },

  cli: {
    watching: (repo: string, url: string) => `gitva следит за ${repo}\n${url}\n`,
    serving: (host: string, port: number) =>
      `${host}:${port} открыт в сеть — без аутентификации\n`,
  },
  server: {
    noRepo: (path: string) => `в ${path} пока нет репозитория — ждём \`git init\``,
  },
};
