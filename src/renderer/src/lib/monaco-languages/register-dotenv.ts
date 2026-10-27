import type * as Monaco from 'monaco-editor'

type DotenvMonaco = {
  languages: Pick<
    typeof Monaco.languages,
    'getLanguages' | 'register' | 'setLanguageConfiguration' | 'setMonarchTokensProvider'
  >
}

export const DOTENV_LANGUAGE_ID = 'dotenv'

const INTERPOLATION = /\$\{[^}]*\}|\$[A-Za-z_]\w*/

export const dotenvLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  // Pair colouring would otherwise recolour the braces of ${VAR}.
  brackets: [],
  colorizedBracketPairs: [],
  autoClosingPairs: [
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] }
  ],
  surroundingPairs: [
    { open: '"', close: '"' },
    { open: "'", close: "'" }
  ]
}

export const dotenvMonarchLanguage: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.dotenv',

  tokenizer: {
    root: [
      [/^\s*#.*$/, 'comment'],
      [/^(\s*)(export)(\s+)/, ['white', 'keyword', 'white']],
      [/[A-Za-z_][\w.-]*(?=\s*=)/, 'type.identifier'],
      [/=/, 'delimiter', '@value'],
      [/\s+/, 'white']
    ],

    // Unquoted values end at the line; only quoted values may span lines.
    value: [
      [/^/, '', '@pop'],
      [/\s+#.*$/, 'comment'],
      [/"/, 'string', '@doubleQuoted'],
      [/'/, 'string', '@singleQuoted'],
      [INTERPOLATION, 'variable'],
      [/(?:true|false)(?=\s+#|\s*$)/, 'keyword'],
      [/-?\d+(?:\.\d+)?(?=\s+#|\s*$)/, 'number'],
      [/[^\s#"'$]+|[#$]/, 'string'],
      [/\s+/, 'string']
    ],

    doubleQuoted: [
      [/[^"\\$]+/, 'string'],
      [/\\./, 'string.escape'],
      [INTERPOLATION, 'variable'],
      [/[\\$]/, 'string'],
      [/"/, 'string', '@pop']
    ],

    // Single quotes are literal: no escapes or interpolation.
    singleQuoted: [
      [/[^']+/, 'string'],
      [/'/, 'string', '@pop']
    ]
  }
}

export function registerDotenvLanguage(monaco: DotenvMonaco): void {
  const languageAlreadyRegistered = monaco.languages
    .getLanguages()
    .some((language) => language.id === DOTENV_LANGUAGE_ID)
  if (languageAlreadyRegistered) {
    return
  }

  monaco.languages.register({
    id: DOTENV_LANGUAGE_ID,
    extensions: ['.env'],
    filenames: ['.env'],
    aliases: ['Dotenv', 'dotenv', 'env']
  })
  monaco.languages.setLanguageConfiguration(DOTENV_LANGUAGE_ID, dotenvLanguageConfiguration)
  monaco.languages.setMonarchTokensProvider(DOTENV_LANGUAGE_ID, dotenvMonarchLanguage)
}
