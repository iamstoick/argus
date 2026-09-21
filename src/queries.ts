/** Tree-sitter S-expression query packs, one symbol query + one ref query per language. */
import type { LanguageId } from './config.js';

export interface LanguageQueries {
  /** Captures `@sym.<kind>` on declaration nodes and `@sym.name` on name nodes. */
  symbols: string;
  /** Captures `@ref.calls` / `@ref.extends` / `@ref.implements` on referenced names. */
  refs: string;
}

const JS_FUNCTIONS = `
(function_declaration
  name: (identifier) @sym.name) @sym.function
(generator_function_declaration
  name: (identifier) @sym.name) @sym.function
(method_definition
  name: (property_identifier) @sym.name) @sym.method
(method_definition
  name: (private_property_identifier) @sym.name) @sym.method
(variable_declarator
  name: (identifier) @sym.name
  value: [(arrow_function) (function_expression)]) @sym.function
(assignment_expression
  left: (identifier) @sym.name
  right: [(arrow_function) (function_expression)]) @sym.function
`;

const JS_CLASS = `
(class_declaration
  name: (identifier) @sym.name) @sym.class
`;

// TypeScript names classes with type_identifier, unlike JavaScript.
const TS_CLASS = `
(class_declaration
  name: (type_identifier) @sym.name) @sym.class
(abstract_class_declaration
  name: (type_identifier) @sym.name) @sym.class
`;

const JS_CALLS = `
(call_expression
  function: (identifier) @ref.calls)
(call_expression
  function: (member_expression
    property: (property_identifier) @ref.calls))
(new_expression
  constructor: (identifier) @ref.calls)
`;

const JS_EXTENDS = `
(class_declaration
  (class_heritage
    (identifier) @ref.extends))
`;

const TS_EXTENDS = `
(class_declaration
  (class_heritage
    (extends_clause
      value: (identifier) @ref.extends)))
(class_declaration
  (class_heritage
    (extends_clause
      value: (member_expression
        property: (property_identifier) @ref.extends))))
(class_declaration
  (class_heritage
    (implements_clause
      (type_identifier) @ref.implements)))
`;

const JS_SYMBOLS = `
${JS_FUNCTIONS}
${JS_CLASS}
`;

const JS_REFS = `
${JS_CALLS}
${JS_EXTENDS}
`;

const TS_SYMBOLS = `
${JS_FUNCTIONS}
${TS_CLASS}
(interface_declaration
  name: (type_identifier) @sym.name) @sym.interface
(type_alias_declaration
  name: (type_identifier) @sym.name) @sym.type
(enum_declaration
  name: (identifier) @sym.name) @sym.enum
`;

const TS_REFS = `
${JS_CALLS}
${TS_EXTENDS}
`;

const QUERIES: Readonly<Record<LanguageId, LanguageQueries>> = {
  javascript: { symbols: JS_SYMBOLS, refs: JS_REFS },
  typescript: { symbols: TS_SYMBOLS, refs: TS_REFS },
  tsx: { symbols: TS_SYMBOLS, refs: TS_REFS },

  python: {
    symbols: `
(function_definition
  name: (identifier) @sym.name) @sym.function
(class_definition
  name: (identifier) @sym.name) @sym.class
(decorated_definition
  definition: (function_definition
    name: (identifier) @sym.name) @sym.function)
(decorated_definition
  definition: (class_definition
    name: (identifier) @sym.name) @sym.class)
`,
    refs: `
(call
  function: (identifier) @ref.calls)
(call
  function: (attribute
    attribute: (identifier) @ref.calls))
(class_definition
  superclasses: (argument_list
    (identifier) @ref.extends))
`,
  },

  go: {
    symbols: `
(function_declaration
  name: (identifier) @sym.name) @sym.function
(method_declaration
  name: (field_identifier) @sym.name) @sym.method
(type_declaration
  (type_spec
    name: (type_identifier) @sym.name
    type: (struct_type)) @sym.struct)
(type_declaration
  (type_spec
    name: (type_identifier) @sym.name
    type: (interface_type)) @sym.interface)
(type_declaration
  (type_spec
    name: (type_identifier) @sym.name) @sym.type)
`,
    refs: `
(call_expression
  function: (identifier) @ref.calls)
(call_expression
  function: (selector_expression
    field: (field_identifier) @ref.calls))
`,
  },

  rust: {
    symbols: `
(function_item
  name: (identifier) @sym.name) @sym.function
(struct_item
  name: (type_identifier) @sym.name) @sym.struct
(enum_item
  name: (type_identifier) @sym.name) @sym.enum
(trait_item
  name: (type_identifier) @sym.name) @sym.trait
(impl_item
  type: (_)
  body: (declaration_list
    (function_item
      name: (identifier) @sym.name) @sym.method))
(mod_item
  name: (identifier) @sym.name) @sym.module
(type_item
  name: (type_identifier) @sym.name) @sym.type
`,
    refs: `
(call_expression
  function: (identifier) @ref.calls)
(call_expression
  function: (field_expression
    field: (field_identifier) @ref.calls))
(call_expression
  function: (scoped_identifier
    name: (identifier) @ref.calls))
`,
  },

  php: {
    symbols: `
(function_definition
  name: (name) @sym.name) @sym.function
(class_declaration
  name: (name) @sym.name) @sym.class
(method_declaration
  name: (name) @sym.name) @sym.method
(interface_declaration
  name: (name) @sym.name) @sym.interface
(trait_declaration
  name: (name) @sym.name) @sym.trait
(enum_declaration
  name: (name) @sym.name) @sym.enum
`,
    refs: `
(function_call_expression
  function: (name) @ref.calls)
(member_call_expression
  name: (name) @ref.calls)
(object_creation_expression
  (name) @ref.calls)
(scoped_call_expression
  name: (name) @ref.calls)
(class_declaration
  (base_clause
    (name) @ref.extends))
(class_interface_clause
  (name) @ref.implements)
`,
  },

  ruby: {
    symbols: `
(method
  name: [(identifier) (constant)] @sym.name) @sym.function
(singleton_method
  name: [(identifier) (constant)] @sym.name) @sym.method
(class
  name: [(constant) (scope_resolution)] @sym.name) @sym.class
(module
  name: [(constant) (scope_resolution)] @sym.name) @sym.module
`,
    refs: `
(call
  method: (identifier) @ref.calls)
(class
  superclass: (superclass
    [(constant) (scope_resolution)] @ref.extends))
`,
  },
};

export function queriesFor(lang: LanguageId): LanguageQueries {
  return QUERIES[lang];
}
