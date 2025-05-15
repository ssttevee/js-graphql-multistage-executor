import {
  GraphQLError,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLUnionType,
  defaultFieldResolver,
  defaultTypeResolver,
  getNamedType,
  getNullableType,
  isAbstractType,
  isCompositeType,
  isEnumType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  type ExecutionArgs,
  type ExecutionResult,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLAbstractType,
  type GraphQLField,
  type GraphQLFieldResolver,
  type GraphQLLeafType,
  type GraphQLOutputType,
  type GraphQLResolveInfo,
  type GraphQLSchema,
  type GraphQLTypeResolver,
  type OperationDefinitionNode,
  type SelectionNode,
} from "graphql";
import { getFieldDef } from "graphql/execution/execute";
import { type Path, addPath, pathToArray } from "graphql/jsutils/Path";
import { resolveArguments } from "./arguments";
import { extractOperationAndFragments } from "./ast";
import { getRootType } from "./helpers";
import { selectionFields } from "./selection";
import {
  type Middleware,
  findImplementors,
  flattenMiddleware,
  isNullValue,
  selectFromObject,
  zip,
} from "./utils";

export type WrappedValue<T> = PromiseLike<T> &
  (Exclude<T, null | undefined> extends Array<infer E>
    ? Array<WrappedValue<E>>
    : Exclude<T, null | undefined> extends object
      ? { [P in keyof T]-?: WrappedValue<T[P]> }
      : unknown);

export interface ExpandedChild {
  fieldNode: FieldNode;
  path: Path;
  concreteType: GraphQLObjectType;
  sourceValue: unknown;
  setData: (data: any) => void;
}

export interface ExpandedAbstractType {
  concreteType: GraphQLObjectType;
  sourceValue: unknown;
  setDeferred: (v: any) => void;
}

export type GraphQLCompositeOutputType =
  | GraphQLObjectType
  | GraphQLInterfaceType
  | GraphQLUnionType
  | GraphQLList<GraphQLCompositeOutputType>
  | GraphQLNonNull<
      | GraphQLObjectType
      | GraphQLInterfaceType
      | GraphQLUnionType
      | GraphQLList<GraphQLCompositeOutputType>
    >;

function isCompositeOutputType(
  type: GraphQLOutputType,
): type is GraphQLCompositeOutputType {
  while (true) {
    if (isCompositeType(type)) {
      return true;
    }

    if (type instanceof GraphQLList || type instanceof GraphQLNonNull) {
      type = type.ofType;
      continue;
    }

    return false;
  }
}

function arrayToPath(arr: [string | number, ...Array<string | number>]): Path;
function arrayToPath(arr: Array<string | number>): Path | undefined;
function arrayToPath(arr: Array<string | number>): Path | undefined {
  let path: Path | undefined;
  for (const key of arr) {
    path = addPath(path, key, undefined);
  }

  return path;
}

export interface ExecutorBackend<TDeferred> {
  unwrapResolvedValue: (value: WrappedValue<any>) => unknown;
  isWrappedValue: (value: unknown) => value is WrappedValue<any>;
  wrapSourceValue(
    sourceValue: unknown,
    getValue: () => Promise<unknown>,
  ): WrappedValue<any>;
  isDeferredValue(value: unknown): value is TDeferred;
  resolveDeferredValues(
    values: Array<[TDeferred, Path]>,
    executionArgs: ExecutionArgs,
  ): Promise<unknown[]>;
  expandChildren(
    path: Path,
    parentValue: TDeferred,
    parentType: GraphQLCompositeOutputType,
    fieldNodes: Map<GraphQLObjectType, readonly FieldNode[]>,
    setDeferred: (data: TDeferred) => void,
    args: ExecutionArgs,
  ): Iterable<ExpandedChild>;
  getErrorMessage?: (value: unknown) => string | null;
}

type SerializeFunction = (value: any, contextValue: any) => unknown;

const identity: SerializeFunction = (v) => v;

interface BuildResolveInfoInput {
  fieldNode: FieldNode;
  fieldNodes: readonly FieldNode[];
  path: Path;
  parentType: GraphQLObjectType;
}

function fieldNodeKey(node: FieldNode): string {
  return (node.alias ?? node.name)?.value;
}

interface FieldToResolve {
  sourceValue: any;
  parentType: GraphQLObjectType;
  fieldNodes: FieldNode[];
  fieldNodeIndex: number;
  parentPath?: Path;
}

const nextStage = Symbol();

export type FieldResolverGetter<TSource, TContext> = {
  (
    fieldDefinition: GraphQLField<TSource, TContext, any>,
    executionArgs: ExecutionArgs,
    defaultFieldResolver: GraphQLFieldResolver<TSource, TContext>,
  ): GraphQLFieldResolver<TSource, TContext>;
};

function defaultFieldResolverGetter(
  fieldDef: GraphQLField<unknown, unknown, any>,
  args: ExecutionArgs,
  defaultFieldResolver: GraphQLFieldResolver<unknown, unknown>,
) {
  return fieldDef.resolve ?? args.fieldResolver ?? defaultFieldResolver;
}

export type TypeResolverGetter<TSource, TContext> = {
  (
    fieldDefinition: GraphQLAbstractType,
    executionArgs: ExecutionArgs,
    defaultTypeResolver: GraphQLTypeResolver<TSource, TContext>,
  ): GraphQLTypeResolver<TSource, TContext>;
};

function defaultTypeResolverGetter(
  fieldType: GraphQLAbstractType,
  args: ExecutionArgs,
  defaultTypeResolver: GraphQLTypeResolver<unknown, unknown>,
) {
  return fieldType.resolveType ?? args.typeResolver ?? defaultTypeResolver;
}

export type SerializerGetter<TSource, TContext> = {
  (
    fieldType: GraphQLLeafType,
    fieldNode: FieldNode,
    parentType: GraphQLObjectType<TSource, TContext>,
    path: Path,
    executionArgs: ExecutionArgs,
  ): SerializeFunction | undefined | null;
};

function defaultSerializerGetter(fieldType: GraphQLLeafType) {
  return fieldType.serialize?.bind(fieldType);
}

export type FieldResolverGetterMiddleware<TSource, TContext> = Middleware<
  FieldResolverGetter<TSource, TContext>
>;

export type FieldResolverMiddleware<
  TSource,
  TContext,
  TArgs = any,
  TResult = unknown,
> = Middleware<GraphQLFieldResolver<TSource, TContext, TArgs, TResult>>;

export type TypeResolverGetterMiddleware<TSource, TContext> = Middleware<
  TypeResolverGetter<TSource, TContext>
>;

export type SerializerGetterMiddleware<TSource, TContext> = Middleware<
  SerializerGetter<TSource, TContext>
>;

export type ResolveDeferredValuesMiddleware<TDeferred> = Middleware<
  ExecutorBackend<TDeferred>["resolveDeferredValues"]
>;

type MaybeArray<T> = T | T[];

interface Middlewares<TSource, TContext, TDeferred> {
  fieldResolverMiddleware?: MaybeArray<
    FieldResolverMiddleware<TSource, TContext>
  >;
  fieldResolverGetterMiddleware?: MaybeArray<
    FieldResolverGetterMiddleware<TSource, TContext>
  >;
  typeResolverGetterMiddleware?: MaybeArray<
    TypeResolverGetterMiddleware<TSource, TContext>
  >;
  serializerGetterMiddleware?: MaybeArray<
    SerializerGetterMiddleware<TSource, TContext>
  >;
  resolveDeferredValuesMiddleware?: MaybeArray<
    ResolveDeferredValuesMiddleware<TDeferred>
  >;
}

interface Hooks<TSource, TContext, TDeferred> {
  fieldResolverMiddleware: FieldResolverMiddleware<TSource, TContext>;
  fieldResolverGetterMiddleware: FieldResolverGetterMiddleware<
    TSource,
    TContext
  >;
  typeResolverGetterMiddleware: TypeResolverGetterMiddleware<TSource, TContext>;
  serializerGetterMiddleware: SerializerGetterMiddleware<TSource, TContext>;
  resolveDeferredValuesMiddleware: ResolveDeferredValuesMiddleware<TDeferred>;
}

export interface CreateExecuteFnOptions<TSource, TContext, TDeferred>
  extends Middlewares<TSource, TContext, TDeferred> {}

class Execution<TDeferred> {
  readonly #backend: ExecutorBackend<TDeferred>;
  readonly #args: ExecutionArgs;

  readonly #operation: OperationDefinitionNode;
  readonly #fragmentMap: Record<string, FragmentDefinitionNode>;
  readonly #rootType: GraphQLObjectType<any, any>;
  readonly #unionMap: Record<string, GraphQLUnionType>;

  #step1_resolve: Array<FieldToResolve> = [];
  #step2_evaluate: Array<
    | [value: any, path: Path, parentTypeCheck: string | undefined]
    | [value: any, path: Path]
  > = [];
  #step3_restage: Array<Omit<FieldToResolve, "sourceValue">> = [];

  readonly #unvalidatedResult: Record<string, any> = {};

  #resultErrors: GraphQLError[] = [];

  #fieldResolverMiddleware: FieldResolverMiddleware<unknown, unknown>;
  #getFieldResolver: FieldResolverGetter<unknown, unknown>;
  #getTypeResolver: TypeResolverGetter<unknown, unknown>;
  #getSerializer: SerializerGetter<unknown, unknown>;
  #resolveDeferredValues: ExecutorBackend<TDeferred>["resolveDeferredValues"];

  get #schema(): GraphQLSchema {
    return this.#args.schema;
  }

  get #variableValues(): Record<string, unknown> {
    return this.#args.variableValues || {};
  }

  constructor(
    backend: ExecutorBackend<TDeferred>,
    args: ExecutionArgs,
    hooks: Hooks<unknown, unknown, TDeferred>,
  ) {
    this.#backend = backend;
    this.#args = args;
    if (
      typeof this.#args.contextValue !== "object" ||
      !this.#args.contextValue
    ) {
      this.#args.contextValue = {};
    }

    this.#fieldResolverMiddleware = hooks.fieldResolverMiddleware;
    this.#getFieldResolver = hooks.fieldResolverGetterMiddleware(
      defaultFieldResolverGetter,
    );
    this.#getTypeResolver = hooks.typeResolverGetterMiddleware(
      defaultTypeResolverGetter,
    );
    this.#getSerializer = hooks.serializerGetterMiddleware(
      defaultSerializerGetter,
    );
    this.#resolveDeferredValues = hooks.resolveDeferredValuesMiddleware(
      backend.resolveDeferredValues,
    );

    const [operation, fragmentNodes] = extractOperationAndFragments(
      args.document,
    );
    this.#operation = operation;
    this.#fragmentMap = Object.fromEntries(
      (fragmentNodes || []).map((fragment) => [fragment.name.value, fragment]),
    );

    const rootType = getRootType(this.#schema, operation);
    if (!rootType) {
      throw new Error(`missing ${operation.operation} type`);
    }

    this.#rootType = rootType;

    this.#unionMap = Object.fromEntries(
      Object.entries(this.#schema.getTypeMap()).filter(
        (pair): pair is [string, GraphQLUnionType] =>
          pair[1] instanceof GraphQLUnionType,
      ),
    );

    this.#step1_resolve.push(
      ...this.#buildUnresolvedFields(
        undefined,
        rootType,
        args.rootValue,
        operation.selectionSet.selections,
      ),
    );
  }

  public async execute(): Promise<void> {
    while (this.#step1_resolve.length) {
      for (const [path, value] of await Promise.all(
        this.#step1_resolve
          .splice(0, this.#step1_resolve.length)
          .map(
            async (f): Promise<[Path, any]> => [
              addPath(
                f.parentPath,
                fieldNodeKey(f.fieldNodes[f.fieldNodeIndex]),
                undefined,
              ),
              await this.#resolveObjectField(
                f.sourceValue,
                f.parentType,
                f.fieldNodes,
                f.fieldNodeIndex,
                f.parentPath,
              ),
            ],
          ),
      )) {
        this.#setCompletedPiece(pathToArray(path), value);
      }

      if (this.#step2_evaluate.length) {
        const entries = this.#step2_evaluate;
        this.#step2_evaluate = [];

        const deferredValues: Array<[TDeferred, Path]> = [];
        const originalIndices: number[] = [];
        for (const [i, [value, path]] of entries.entries()) {
          if (this.#isDeferredValue(value)) {
            originalIndices[deferredValues.length] = i;
            deferredValues.push([value, path]);
          }
        }

        for (const [i, resolvedValue] of zip(
          originalIndices,
          await this.#resolveDeferredValues(deferredValues, this.#args),
        )) {
          entries[i][0] = resolvedValue;
        }

        for (const [value, path, parentTypeCheck] of entries) {
          this.#setCompletedPiece(pathToArray(path), value, parentTypeCheck);
        }
      }

      while (this.#step3_restage.length) {
        const entries = this.#step3_restage;
        this.#step3_restage = [];

        outer: for (const field of entries) {
          let sourceValue: any = this.#unvalidatedResult;
          const path = pathToArray(field.parentPath);
          for (const [i, key] of path.entries()) {
            if (
              sourceValue === null ||
              this.#backend.getErrorMessage?.(sourceValue)
            ) {
              // quietly ignore this, the error should be handled elsewhere
              continue outer;
            }

            if (key === "[]") {
              if (Array.isArray(sourceValue)) {
                this.#step3_restage.push(
                  ...Array.from(sourceValue, (_, j) => ({
                    ...field,
                    parentPath: arrayToPath([
                      ...path.slice(0, i),
                      j,
                      ...path.slice(i + 1),
                    ]),
                  })),
                );
              }

              continue outer;
            }

            if (typeof sourceValue[key] === "undefined") {
              continue outer;
            }

            sourceValue = sourceValue[key];
          }

          try {
            this.#step1_resolve.push({
              ...field,
              sourceValue,
            });
          } catch (err) {
            if (err instanceof GraphQLError) {
              this.#resultErrors.push(err);
            } else {
              throw err;
            }
          }
        }
      }
    }
  }

  public async getResult<T>(): Promise<ExecutionResult<T>> {
    const result: ExecutionResult<T> = {
      data: await this.#getValidatedObjectValue(
        this.#unvalidatedResult,
        this.#rootType,
        selectionFields(
          this.#schema,
          this.#fragmentMap,
          this.#unionMap,
          this.#operation.selectionSet.selections,
          this.#rootType,
        ),
      ),
    };
    if (this.#resultErrors.length) {
      // dedupe errors
      const fingerprints = new Set();
      result.errors = [];
      for (const error of this.#resultErrors) {
        const fingerprint = JSON.stringify(error);
        if (fingerprints.has(fingerprint) && fingerprints.add(fingerprint)) {
          continue;
        }

        (result.errors as GraphQLError[]).push(error);
      }
    }

    return result;
  }

  async #getValidatedObjectValue(
    objectValue: any,
    objectType: GraphQLObjectType,
    fieldNodes: FieldNode[],
    path?: Path,
  ): Promise<any> {
    const fieldValues = await Promise.all(
      fieldNodes.map(
        async (
          fieldNode,
          fieldNodeIndex,
        ): Promise<[FieldNode, GraphQLOutputType, any]> => {
          const key = fieldNodeKey(fieldNode);
          const fieldType = getFieldDef(
            this.#schema,
            objectType,
            fieldNode,
          )!.type;
          const fieldPath = addPath(path, key, undefined);
          return [
            fieldNode,
            fieldType,
            await this.#getValidatedValueRecursive(
              objectValue?.[key],
              fieldType,
              fieldNodes,
              fieldNodeIndex,
              objectType,
              fieldPath,
            ).catch((e) => {
              this.#resultErrors.push(
                new GraphQLError((e as any)?.message ?? String(e), {
                  nodes: (e as any).nodes ?? [fieldNode],
                  source: (e as any).source ?? fieldNode.loc?.source,
                  positions:
                    (e as any).positions ??
                    (fieldNode.loc?.source && [fieldNode.loc.start]),
                  path: (e as any).path ?? pathToArray(fieldPath),
                  originalError: e as any,
                }),
              );

              return null;
            }),
          ];
        },
      ),
    );

    if (fieldValues.some(([_, t, v]) => isNonNullType(t) && isNullValue(v))) {
      return null;
    }

    return Object.fromEntries(
      fieldValues.map(([fieldNode, _, value]) => [
        fieldNodeKey(fieldNode),
        value,
      ]),
    );
  }

  async #getValidatedValueRecursive(
    fieldValue: any,
    fieldType: GraphQLOutputType,
    fieldNodes: readonly FieldNode[],
    fieldNodeIndex: number,
    parentType: GraphQLObjectType,
    path: Path,
  ): Promise<any> {
    const fieldNode = fieldNodes[fieldNodeIndex];
    const errorMessage = this.#backend.getErrorMessage?.(fieldValue);
    if (errorMessage) {
      this.#resultErrors.push(
        new GraphQLError(errorMessage, {
          nodes: fieldNode,
          source: fieldNode.loc?.source,
          positions: fieldNode.loc?.source && [fieldNode.loc.start],
          path: pathToArray(path),
        }),
      );
      return null;
    }

    if (isNonNullType(fieldType)) {
      if (isNullValue(fieldValue)) {
        this.#resultErrors.push(
          new GraphQLError("Cannot return null for non-nullable field", {
            nodes: fieldNode,
            source: fieldNode.loc?.source,
            positions: fieldNode.loc?.source && [fieldNode.loc.start],
            path: pathToArray(path),
          }),
        );
        return null;
      }

      const value = await this.#getValidatedValueRecursive(
        fieldValue,
        fieldType.ofType,
        fieldNodes,
        fieldNodeIndex,
        parentType,
        path,
      );
      // TODO: consider necessity of checking for null here
      return value;
    }

    if (isNullValue(fieldValue)) {
      return null;
    }

    if (isListType(fieldType)) {
      if (!Array.isArray(fieldValue)) {
        this.#resultErrors.push(
          new GraphQLError("Cannot return non-list value for list field", {
            nodes: fieldNode,
            source: fieldNode.loc?.source,
            positions: fieldNode.loc?.source && [fieldNode.loc.start],
            path: pathToArray(path),
          }),
        );
        return null;
      }

      if (fieldValue.length === 0) {
        return fieldValue;
      }

      const result = await Promise.all(
        Array.from(fieldValue, (elem, index) =>
          this.#getValidatedValueRecursive(
            elem,
            fieldType.ofType,
            fieldNodes,
            fieldNodeIndex,
            parentType,
            addPath(path, index, undefined),
          ),
        ),
      );
      if (getNullableType(fieldType.ofType) !== fieldType.ofType) {
        if (result.some(isNullValue)) {
          return null;
        }
      }

      return result.filter((v) => v !== null);
    }

    if (isLeafType(fieldType)) {
      if (isEnumType(fieldType) && Array.isArray(fieldValue)) {
        this.#resultErrors.push(
          new GraphQLError("Cannot return list value for non-list field", {
            nodes: fieldNode,
            source: fieldNode.loc?.source,
            positions: fieldNode.loc?.source && [fieldNode.loc.start],
            path: pathToArray(path),
          }),
        );
        return null;
      }

      return await this.#serializeValue(
        fieldValue,
        fieldType,
        fieldNode,
        parentType,
        path,
      );
    }

    let concreteType: GraphQLObjectType;
    if (isAbstractType(fieldType)) {
      const resolvedType = await this.#resolveType(fieldType, fieldValue, {
        fieldNode,
        fieldNodes,
        path,
        parentType: parentType,
      });
      if (!resolvedType) {
        return;
      }

      concreteType = resolvedType;
    } else {
      concreteType = fieldType;
    }

    return this.#getValidatedObjectValue(
      fieldValue,
      concreteType,
      selectionFields(
        this.#schema,
        this.#fragmentMap,
        this.#unionMap,
        fieldNode.selectionSet?.selections ?? [],
        concreteType,
      ),
      path,
    );
  }

  #setCompletedPiece(
    path: Array<string | number>,
    value: any,
    parentTypeCheck?: string,
  ): void {
    let node = this.#unvalidatedResult;
    for (const [i, key] of path.slice(0, -1).entries()) {
      if (node === null || this.#backend.getErrorMessage?.(node)) {
        // quietly ignore this, the error should be handled elsewhere
        return;
      }

      if (key === "[]") {
        if (!Array.isArray(node)) {
          throw new Error("Expected array but got non-array value");
        }

        for (let j = 0; j < node.length; j++) {
          this.#setCompletedPiece(
            [...path.slice(0, i), j, ...path.slice(i + 1)],
            value,
            parentTypeCheck,
          );
        }

        return;
      }

      if (typeof key === "number") {
        if (!Array.isArray(node)) {
          throw new Error("Expected array but got non-array value");
        }

        if (key >= node.length) {
          node.push(...new Array(key - node.length + 1).fill(undefined));
        }

        if (typeof node[key] !== "object") {
          if (i < path.length - 2 && typeof path[i + 1] === "number") {
            node[key] = [];
          } else {
            node[key] = {};
          }
        }

        node = node[key];
      } else {
        if (Array.isArray(node)) {
          throw new Error("Expected object but got array value");
        }

        if (typeof node[key] !== "object") {
          if (i < path.length - 2 && typeof path[i + 1] === "number") {
            node[key] = [];
          } else {
            node[key] = {};
          }
        }

        node = node[key];
      }
    }

    if (node && (!parentTypeCheck || node.__typename === parentTypeCheck)) {
      node[path[path.length - 1]] = value;
    }
  }

  async #resolveObjectFields(
    sourceValue: any,
    objectType: GraphQLObjectType,
    fieldNodes: FieldNode[],
    path: Path | undefined,
  ): Promise<any> {
    return Object.fromEntries(
      await Promise.all(
        fieldNodes.map(async (fieldNode, i): Promise<[string, any]> => {
          return [
            fieldNodeKey(fieldNode),
            await this.#resolveObjectField(
              sourceValue,
              objectType,
              fieldNodes,
              i,
              path,
            ),
          ];
        }),
      ),
    );
  }

  async #resolveObjectField(
    sourceValue: any,
    objectType: GraphQLObjectType,
    fieldNodes: FieldNode[],
    fieldNodeIndex: number,
    objectPath: Path | undefined,
    setDeferredChild?: (expr: TDeferred) => void,
    isAbstractParent?: boolean,
  ): Promise<any> {
    const fieldNode = fieldNodes[fieldNodeIndex];
    const fieldPath = addPath(objectPath, fieldNodeKey(fieldNode), undefined);
    try {
      const fieldDef = getFieldDef(this.#schema, objectType, fieldNode)!;
      const resolvedValue = await this.#executeFieldResolver(
        sourceValue,
        objectType,
        fieldDef,
        fieldNodes,
        fieldNodeIndex,
        fieldPath,
      );

      let setResult: ((data: any) => void) | undefined;
      if (setDeferredChild && !this.#isDeferredValue(resolvedValue)) {
        // don't put literal values into the query
        const exprs = this.#step2_evaluate;
        const index = exprs.length;
        exprs.push([
          null,
          fieldPath,
          isAbstractParent ? objectType.name : undefined,
        ]);
        setResult = (data) => {
          exprs[index][0] = data;
        };
      }

      const result = await this.#handleResolvedValue(
        resolvedValue,
        fieldDef.type,
        fieldNodes,
        fieldNodeIndex,
        objectType,
        fieldPath,
        setDeferredChild,
      );
      if (setResult) {
        setResult(result);
        return null;
      }

      return result;
    } catch (e) {
      if (e === nextStage) {
        this.#step3_restage.push({
          fieldNodes,
          fieldNodeIndex,
          parentType: objectType,
          parentPath: objectPath,
        });
      } else {
        this.#resultErrors.push(
          new GraphQLError((e as any)?.message ?? String(e), {
            nodes: (e as any).nodes ?? [fieldNode],
            source: (e as any).source ?? fieldNode.loc?.source,
            positions:
              (e as any).positions ??
              (fieldNode.loc?.source && [fieldNode.loc.start]),
            path: (e as any).path ?? pathToArray(fieldPath),
            originalError: e as any,
          }),
        );
      }
    }

    return null;
  }

  async #handleResolvedValue(
    resolvedValue: any,
    valueType: GraphQLOutputType,
    fieldNodes: FieldNode[],
    fieldNodeIndex: number,
    parentType: GraphQLObjectType,
    path: Path,
    setDeferredChild?: (expr: TDeferred) => void,
  ): Promise<any> {
    const fieldNode = fieldNodes[fieldNodeIndex];
    if (this.#isDeferredValue(resolvedValue)) {
      if (setDeferredChild) {
        setDeferredChild(resolvedValue);
      } else {
        // This field is either a top level field or a follow up to a resolver that awaited a deferred value

        // capture the current array so that changes after resolving don't affect the new array
        const exprs = this.#step2_evaluate;
        const index = this.#step2_evaluate.length;
        exprs.push([resolvedValue, path]);
        setDeferredChild = (expr) => {
          exprs[index] = [expr, path];
        };
      }

      if (!isCompositeOutputType(valueType)) {
        // there are no child fields to resolve
        return;
      }

      const namedFieldType = getNamedType(valueType);

      /**
       * Map of concrete types to their selected fieldNodes
       */
      const selectionsMap = new Map(
        Array.from(
          namedFieldType instanceof GraphQLInterfaceType
            ? findImplementors(this.#schema, namedFieldType)
            : namedFieldType instanceof GraphQLUnionType
              ? namedFieldType.getTypes()
              : [namedFieldType as GraphQLObjectType],
          (concreteType) => [
            concreteType,
            selectionFields(
              this.#schema,
              this.#fragmentMap,
              this.#unionMap,
              fieldNode.selectionSet?.selections ?? [],
              concreteType,
            ),
          ],
        ),
      );

      await Promise.all(
        Array.from(
          this.#expandChildren(
            path,
            resolvedValue,
            valueType,
            selectionsMap,
            setDeferredChild,
          ),
          (child) => {
            const fieldNodes = selectionsMap.get(child.concreteType)!;
            const fieldNodeIndex = fieldNodes.findIndex(
              (n) => n === child.fieldNode,
            );
            return this.#resolveObjectField(
              child.sourceValue,
              child.concreteType,
              fieldNodes,
              fieldNodeIndex,
              child.path,
              child.setData,
              isAbstractType(namedFieldType),
            );
          },
        ),
      );

      return null;
    }

    if (isNullValue(resolvedValue)) {
      return null;
    }

    while (valueType instanceof GraphQLNonNull) {
      valueType = valueType.ofType;
    }

    if (valueType instanceof GraphQLList) {
      if (!Array.isArray(resolvedValue)) {
        this.#resultErrors.push(
          new GraphQLError("Cannot return non-list value for list field", {
            nodes: fieldNode,
            source: fieldNode.loc?.source,
            positions: fieldNode.loc?.source && [fieldNode.loc.start],
            path: pathToArray(path),
          }),
        );
        return null;
      }

      const elemType = getNullableType(valueType.ofType);
      return await Promise.all(
        Array.from(resolvedValue, (elemValue, i) =>
          this.#handleResolvedValue(
            elemValue,
            elemType,
            fieldNodes,
            fieldNodeIndex,
            parentType,
            addPath(path, i, undefined),
          ),
        ),
      );
    }

    if (isLeafType(valueType)) {
      return resolvedValue;
    }

    const concreteType = isObjectType(valueType)
      ? valueType
      : await this.#resolveType(valueType, resolvedValue, {
          fieldNodes,
          fieldNode,
          path,
          parentType,
        });
    if (!concreteType) {
      return null;
    }

    const result = await this.#resolveObjectFields(
      resolvedValue,
      concreteType,
      selectionFields(
        this.#schema,
        this.#fragmentMap,
        this.#unionMap,
        fieldNode.selectionSet?.selections ?? [],
        concreteType,
      ),
      path,
    );
    if (!result) {
      return result;
    }

    return Object.assign(result, {
      __typename: concreteType.name,
    });
  }

  #buildUnresolvedFields(
    prevPath: Path | undefined,
    parentType: GraphQLObjectType,
    sourceValue: any,
    selectionNodes: readonly SelectionNode[],
  ): Array<FieldToResolve> {
    return selectionFields(
      this.#schema,
      this.#fragmentMap,
      this.#unionMap,
      selectionNodes,
      parentType,
    ).map((_, i, fieldNodes) => ({
      sourceValue,
      parentType,
      fieldNodes,
      fieldNodeIndex: i,
      parentPath: prevPath,
    }));
  }

  #buildResolveInfo(
    input: BuildResolveInfoInput,
    returnType: GraphQLOutputType,
  ): GraphQLResolveInfo {
    return {
      schema: this.#schema,
      rootValue: this.#args.rootValue,
      fragments: this.#fragmentMap,
      operation: this.#operation,
      variableValues: this.#variableValues,
      parentType: input.parentType,
      path: input.path,
      fieldName: input.fieldNode.name.value,
      fieldNodes: input.fieldNodes,
      returnType,
    };
  }

  #isDeferredValue(value: unknown): value is TDeferred {
    return this.#backend.isDeferredValue(value);
  }

  #isWrappedValue(value: unknown): value is WrappedValue<any> {
    return this.#backend.isWrappedValue(value);
  }

  #wrapSourceValue(
    sourceValue: unknown,
    getValue: () => Promise<unknown>,
  ): WrappedValue<any> {
    return this.#backend.wrapSourceValue(sourceValue, getValue);
  }

  #unwrapResolvedValue(value: WrappedValue<any>): unknown {
    return this.#backend.unwrapResolvedValue(value);
  }

  #expandChildren(
    path: Path,
    parentValue: TDeferred,
    parentType: GraphQLCompositeOutputType,
    fieldNodes: Map<GraphQLObjectType, readonly FieldNode[]>,
    setDeferred: (data: TDeferred) => void,
  ) {
    return this.#backend.expandChildren(
      path,
      parentValue,
      parentType,
      fieldNodes,
      setDeferred,
      this.#args,
    );
  }

  async #resolveType(
    fieldType: GraphQLAbstractType,
    fieldValue: any,
    resolveInfoInput: BuildResolveInfoInput,
  ): Promise<GraphQLObjectType | undefined> {
    const typeName = await this.#getTypeResolver(
      fieldType,
      this.#args,
      defaultTypeResolver,
    )(
      fieldValue,
      this.#args.contextValue,
      this.#buildResolveInfo(resolveInfoInput, fieldType),
      fieldType,
    );

    const resolvedType = typeName && this.#schema.getType(typeName);
    if (!resolvedType || !(resolvedType instanceof GraphQLObjectType)) {
      this.#resultErrors.push(
        new GraphQLError("Failed to resolve concrete type", {
          nodes: resolveInfoInput.fieldNode,
          source: resolveInfoInput.fieldNode.loc?.source,
          positions: resolveInfoInput.fieldNode.loc?.source && [
            resolveInfoInput.fieldNode.loc.start,
          ],
          path: pathToArray(resolveInfoInput.path),
        }),
      );
      return;
    }

    return resolvedType;
  }

  async #executeFieldResolver(
    sourceValue: any,
    parentType: GraphQLObjectType,
    fieldDef: GraphQLField<any, any>,
    fieldNodes: FieldNode[],
    fieldNodeIndex: number,
    path: Path,
  ): Promise<any> {
    const fieldNode = fieldNodes[fieldNodeIndex];
    let fieldValue = this.#fieldResolverMiddleware(
      this.#getFieldResolver(fieldDef, this.#args, defaultFieldResolver),
    )(
      this.#isDeferredValue(sourceValue)
        ? this.#wrapSourceValue(sourceValue, () => Promise.reject(nextStage))
        : sourceValue,
      resolveArguments(
        this.#variableValues,
        fieldNode.arguments,
        fieldDef.args,
      ),
      this.#args.contextValue,
      this.#buildResolveInfo(
        {
          fieldNode,
          fieldNodes,
          path,
          parentType,
        },
        fieldDef.type,
      ),
    );

    // value must be unwrapped before being returned (and awaited)
    if (this.#isWrappedValue(fieldValue)) {
      fieldValue = this.#unwrapResolvedValue(fieldValue);
    }

    fieldValue = await fieldValue;

    if (this.#isWrappedValue(fieldValue)) {
      fieldValue = this.#unwrapResolvedValue(fieldValue);
    }

    return fieldValue;
  }

  #serializeValue(
    fieldValue: unknown,
    fieldType: GraphQLLeafType,
    fieldNode: FieldNode,
    parentType: GraphQLObjectType,
    path: Path,
  ): unknown {
    return (
      this.#getSerializer(fieldType, fieldNode, parentType, path, this.#args) ??
      identity
    )(fieldValue, this.#args.contextValue);
  }
}

export function createExecuteFn<TDeferred>(
  backend: ExecutorBackend<TDeferred>,
  options: CreateExecuteFnOptions<unknown, unknown, TDeferred> = {},
): <T = any>(args: ExecutionArgs) => Promise<ExecutionResult<T>> {
  const rootFieldResolverMiddleware = flattenMiddleware(
    options.fieldResolverMiddleware,
  );
  const rootFieldResolverGetterMiddleware = flattenMiddleware(
    options.fieldResolverGetterMiddleware,
  );
  const rootTypeResolverGetterMiddleware = flattenMiddleware(
    options.typeResolverGetterMiddleware,
  );
  const rootSerializerGetterMiddleware = flattenMiddleware(
    options.serializerGetterMiddleware,
  );
  const rootResolveDeferredValuesMiddleware = flattenMiddleware(
    options.resolveDeferredValuesMiddleware,
  );

  return async function execute<T = any>(
    args: ExecutionArgs & Middlewares<unknown, unknown, TDeferred>,
  ): Promise<ExecutionResult<T>> {
    const execution = new Execution(backend, args, {
      fieldResolverMiddleware: flattenMiddleware([
        flattenMiddleware(args.fieldResolverMiddleware),
        rootFieldResolverMiddleware,
      ]),
      fieldResolverGetterMiddleware: flattenMiddleware([
        flattenMiddleware(args.fieldResolverGetterMiddleware),
        rootFieldResolverGetterMiddleware,
      ]),
      typeResolverGetterMiddleware: flattenMiddleware([
        flattenMiddleware(args.typeResolverGetterMiddleware),
        rootTypeResolverGetterMiddleware,
      ]),
      serializerGetterMiddleware: flattenMiddleware([
        flattenMiddleware(args.serializerGetterMiddleware),
        rootSerializerGetterMiddleware,
      ]),
      resolveDeferredValuesMiddleware: flattenMiddleware([
        flattenMiddleware(args.resolveDeferredValuesMiddleware),
        rootResolveDeferredValuesMiddleware,
      ]),
    });

    try {
      await execution.execute();
      return await execution.getResult();
    } catch (err) {
      return {
        errors: Array.from(Array.isArray(err) ? err : [err], (err) =>
          err instanceof GraphQLError
            ? err
            : new GraphQLError(err.message, { originalError: err }),
        ),
      };
    }
  };
}
