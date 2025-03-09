import {
  Client,
  type ClientConfiguration,
  fql,
  type QueryFailure,
  type QueryInterpolation,
  type QueryOptions,
  type QuerySuccess,
  type QueryValue,
  ServiceError,
  Query,
  type QueryArgument,
} from "fauna";
import {
  type ExecutionArgs,
  type FieldNode,
  type GraphQLAbstractType,
  GraphQLError,
  type GraphQLObjectType,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql";
import { addPath, type Path, pathToArray } from "graphql/jsutils/Path";

import type {
  ExecutorBackend,
  ExpandedChild,
  GraphQLCompositeOutputType,
  WrappedValue,
} from "../executor";
import { type Middleware, flattenMiddleware } from "../utils";

// HACK: change this either when there an `isQuery` helper or when `Query` is exported

function isExpr(e: any): e is Query {
  return e && e instanceof Query;
}

type V4Expr = import("faunadb").ExprVal;

function isV4Expr(e: any): e is V4Expr {
  if (e?.[wrapped]) {
    return false;
  }

  if (e?._isFaunaExpr) {
    return true;
  }

  let prototype = e?.prototype ?? e?.constructor?.prototype;
  while (prototype) {
    if (prototype._isFaunaExpr) {
      return true;
    }

    prototype = prototype.prototype;
  }

  return false;
}

function isV4Value(e: any): boolean {
  if (e?.[wrapped]) {
    return false;
  }

  if (e?._isFaunaValue) {
    return true;
  }

  let prototype = e?.prototype ?? e?.constructor?.prototype;
  while (prototype) {
    if (prototype._isFaunaValue) {
      return true;
    }

    prototype = prototype.prototype;
  }

  return false;
}

function customFQL(
  fragments: ReadonlyArray<string>,
  ...queryArgs: (QueryValue | Query | import("faunadb").ExprVal)[]
): Query {
  return fql(fragments, ...queryArgs.map(unwrapValue));
}

export { customFQL as fql };

const wrapped = Symbol("is wrapped");
const original = Symbol("get original");
export const isWrappedValue = (value: any): value is WrappedValue<any> => {
  // HACK: overload the concept of a "wrapped value" to include fauna v4 expressions
  return Boolean(value?.[wrapped] || isV4Expr(value));
};

function queryToString(query: string | QueryInterpolation | Query): string {
  if (isExpr(query)) {
    return query.encode().fql.map(queryToString).join(",");
  }

  if (typeof query === "string") {
    return query;
  }

  if (typeof query !== "object") {
    throw new Error(`unexpected query type: ${typeof query}`);
  }

  if ("value" in query) {
    return `\${${JSON.stringify(query.value)}}`;
  }

  if (!("fql" in query)) {
    throw new Error(`unexpected object shape: ${JSON.stringify(query)}`);
  }

  if (Array.isArray(query.fql)) {
    return query.fql.map(queryToString).join("");
  }

  return queryToString(query.fql);
}

function normalizeV4Object(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      return [k, normalizeV4Query(v)];
    }),
  );
}

function normalizeV4Query(query: any): any {
  if (typeof query === "undefined") {
    throw new Error(
      "Unexpected undefined value, please use null instead if this is intentional",
    );
  }

  if (Array.isArray(query)) {
    return query.map(normalizeV4Query);
  }

  if (query?.[wrapped]) {
    return unwrapValue(query);
  }

  if (isV4Value(query)) {
    return JSON.parse(JSON.stringify(query));
  }

  if (!isV4Expr(query)) {
    return query;
  }

  const raw: any = (query as any).raw;
  if (raw instanceof Query) {
    return raw;
  }

  if (Array.isArray(raw)) {
    return raw.map(normalizeV4Query);
  }

  if (raw.object) {
    return { object: normalizeV4Object(raw.object) };
  }

  if (raw.let) {
    if (Array.isArray(raw.let)) {
      return {
        let: raw.let.map(normalizeV4Object),
        in: normalizeV4Query(raw.in),
      };
    }
  }

  return normalizeV4Object(raw);
}

export function v4ToV10(query: V4Expr): Query {
  const normalized = normalizeV4Query(query);
  return fql`FQL.evalV4(${normalized})`;
}

export function unwrapValue(expr: any) {
  if (isV4Expr(expr)) {
    // HACK: overload the concept of a "wrapped value" to include fauna v4 expressions
    return v4ToV10(expr);
  }

  expr = (expr as any)?.[wrapped] ? (expr as any)[original] : expr;

  if (Array.isArray(expr)) {
    for (const [i, result] of expr.map(unwrapValue).entries()) {
      expr[i] = result;
    }
  } else if (expr instanceof Object && !isExpr(expr)) {
    for (const [k, v] of Object.entries(expr).map(([k, v]) => [
      k,
      unwrapValue(v),
    ])) {
      expr[k] = v;
    }
  }

  return expr;
}

function varIsErrorExpr(varName: string): Query {
  return fql([`(${varName} isa Object&&${varName}["@error"]!=null)`]);
}

function varIsIterableExpr(varName: string): Query {
  return fql([`(${varName} isa Set||${varName} isa Array)`]);
}

function assertIterable(varName: string, expr: Query): Query {
  return fql`if(!${varIsIterableExpr(varName)}){"@error":"expected Set or Array"}else{${expr}}`;
}

function safeMap(varName: string, fnExpr: Query): Query {
  return assertIterable(varName, fql([`${varName}.map(`, ")"], fnExpr));
}

function chainVarErrorOrNull(
  varName: string,
  expr: QueryArgument,
  nullable = true,
): Query {
  return fql(
    [
      `if(${varName}==null)${nullable ? "null " : `{"@error":"Cannot return null for non-nullable field"}`}else if(`,
      `)${varName} else{`,
      "}",
    ],
    varIsErrorExpr(varName),
    expr,
  );
}

function dataContainerAsQuery(dataContainer: Record<string, any>): Query {
  const keys = Object.keys(dataContainer);
  const q = fql(
    [
      ...keys.map(
        (k, i) =>
          `${i === 0 ? "{" : `\n// -- END OF ${keys[i - 1]}\n\n},`}${JSON.stringify(k)}:{\n\n// -- START OF ${k}\n`,
      ),
      `${keys.length ? `\n// -- END OF ${keys[keys.length - 1]}\n\n` : ""}}}`,
    ],
    ...Object.values(dataContainer),
  );

  return q;
}

function pathToIdent(path: Path): string {
  return pathToArray(path)
    .map((k) => (k === "[]" ? "_arr_" : k))
    .join("_");
}

export type QueryFunction = (
  client: Client,
  query: Query,
  executionArgs: ExecutionArgs,
  options?: QueryOptions | undefined,
) => Promise<QuerySuccess<any> | QueryFailure>;
export type TypeResolver = (
  abstractType: GraphQLAbstractType,
  value: QueryArgument,
  executionArgs: ExecutionArgs,
) => QueryArgument;
export type WrappedValuePropGetter = (
  query: Query,
  prop: string | number,
) => Query;

export type QueryMiddleware = Middleware<QueryFunction>;
export type TypeResolverMiddleware = Middleware<TypeResolver>;
export type WrappedValuePropGetterMiddleware =
  Middleware<WrappedValuePropGetter>;

export interface CreateExecutorBackendOptions {
  queryMiddleware?: QueryMiddleware | QueryMiddleware[];
  typeResolverMiddleware?: TypeResolverMiddleware | TypeResolverMiddleware[];
  wrappedValuePropGetterMiddleware?:
    | WrappedValuePropGetterMiddleware
    | WrappedValuePropGetterMiddleware[];
}

function defaultQueryFunction(
  client: Client,
  query: Query,
  executionArgs: ExecutionArgs,
  options: QueryOptions | undefined,
) {
  return client.query(query, options);
}

function defaultTypeResolver(
  abstractType: GraphQLAbstractType,
  value: QueryArgument,
) {
  return fql`(${value})?.__typename??{"@error":${`failed to resolve type for ${abstractType.name}`}}`;
}

function defaultWrappedValuePropGetter(
  query: Query,
  prop: string | number,
): Query {
  return fql(["(", `)?.[${JSON.stringify(prop)}]`], query);
}

const nonnull = Symbol("nonnull");
const list = Symbol("list");

export default function createExecutorBackend(
  input?: ClientConfiguration | Client,
  options: CreateExecutorBackendOptions = {},
): ExecutorBackend<Query> {
  const client = input instanceof Client ? input : new Client(input);

  const runQuery = flattenMiddleware(options.queryMiddleware)(
    defaultQueryFunction,
  );
  const resolveType = flattenMiddleware(options.typeResolverMiddleware)(
    defaultTypeResolver,
  );
  const getWrappedValueProp = flattenMiddleware(
    options.wrappedValuePropGetterMiddleware,
  )(defaultWrappedValuePropGetter);

  const wrapSourceValue = (
    sourceValue: unknown,
    getValue: () => Promise<unknown>,
  ) => {
    if (!(sourceValue instanceof Query)) {
      return sourceValue;
    }

    return new Proxy(sourceValue, {
      get: (target: any, prop: PropertyKey): any => {
        if (prop === wrapped) {
          return true;
        }

        if (prop === original) {
          return sourceValue;
        }

        if (typeof prop === "symbol" || prop === "toQuery") {
          let v = Reflect.get(sourceValue, prop);
          if (typeof v === "function") {
            v = v.bind(sourceValue);
          }

          return v;
        }

        if (prop === "then") {
          return (...args: Parameters<PromiseLike<unknown>["then"]>) =>
            getValue().then(...args);
        }

        if (prop === "encode") {
          return () => sourceValue.encode();
        }

        return wrapSourceValue(
          getWrappedValueProp(sourceValue, prop),
          async () => Reflect.get((await getValue()) as any, prop),
        );
      },
      set: () => {
        throw new Error("cannot set properties on a execution placeholder");
      },
    });
  };

  return {
    resolveDeferredValues: async (input, executionArgs) => {
      const queries = Array.from(input, ([expr]) => expr);
      // const paths = Array.from(input, ([, path]) => pathToArray(path));
      try {
        const combinedQuery = fql(
          ["[", ...new Array(queries.length - 1).fill(","), "]"],
          ...queries.map((q) => fql`{${q}}`),
        );
        return (
          (await runQuery(
            client,
            combinedQuery,
            executionArgs,
          )) as QuerySuccess<any>
        ).data;
      } catch (e) {
        if (!(e instanceof ServiceError)) {
          throw e;
        }

        console.log(e.queryInfo?.summary ?? e.queryInfo, e.constraint_failures);

        throw new GraphQLError(e.code, { originalError: e });
      }
    },
    isDeferredValue: (value: unknown): value is Query => {
      return isExpr(value) || isV4Expr(value);
    },
    wrapSourceValue,
    isWrappedValue,
    unwrapResolvedValue: unwrapValue,
    expandChildren: (
      path: Path,
      parentValue: Query,
      parentType: GraphQLCompositeOutputType,
      fieldNodes: Map<GraphQLObjectType, readonly FieldNode[]>,
      setDeferred: (data: Query) => void,
      args: ExecutionArgs,
    ) => {
      const varName = pathToIdent(path);

      const containerStack: Array<typeof nonnull | typeof list> = [];

      // unwrap all non-null and list types
      while (isNonNullType(parentType) || isListType(parentType)) {
        if (isNonNullType(parentType)) {
          containerStack.push(nonnull);
          // merge multiple non-nulls into one
          while (isNonNullType(parentType)) {
            parentType = parentType.ofType;
          }
        }

        if (isListType(parentType)) {
          containerStack.push(list);
          parentType = parentType.ofType as GraphQLCompositeOutputType;
        }
      }

      let wrapQuery = (query: Query) => query;
      let nullable = true;
      let innerVarName = varName;
      while (containerStack.length) {
        const container = containerStack.pop();
        switch (container) {
          case nonnull:
            nullable = false;
            break;
          case list:
            {
              const newVarName = `${innerVarName}_`;
              wrapQuery = (
                (innerVarNameSaved, wrapQuerySaved, nullableSaved) => (query) =>
                  safeMap(
                    `${newVarName}`,
                    fql(
                      [`(${innerVarNameSaved})=>`, ""],
                      chainVarErrorOrNull(
                        innerVarNameSaved,
                        wrapQuerySaved(query),
                        nullableSaved,
                      ),
                    ),
                  )
              )(innerVarName, wrapQuery, nullable);
              innerVarName = newVarName;
              nullable = true;
              path = addPath(path, "[]", undefined);
            }

            break;
        }
      }

      wrapQuery = (
        (wrapQuerySaved) => (query) =>
          fql(
            [`let ${innerVarName}:Any=`, ";", ""],
            parentValue,
            chainVarErrorOrNull(innerVarName, wrapQuerySaved(query), nullable),
          )
      )(wrapQuery);

      const constParentType = parentType;
      if (isObjectType(constParentType)) {
        const dataContainer: Record<string, any> = {};
        const getQuery = () => dataContainerAsQuery(dataContainer);

        return fieldNodes
          .get(constParentType)!
          .map((fieldNode): ExpandedChild => {
            const key = (fieldNode.alias ?? fieldNode.name).value;
            return {
              concreteType: constParentType,
              fieldNode,
              path,
              sourceValue: fql([varName]),
              setData: (data) => {
                dataContainer[key] = unwrapValue(data);
                setDeferred(wrapQuery(getQuery()));
              },
            };
          });
      }

      const branches: Record<string, Record<string, any>> = {};
      const getQuery = () => {
        const varNameType = `${varName}__typename`;
        return fql(
          [
            `let ${varNameType}={`,
            "};if(",
            `)${varNameType} else{let ${varName}_result:Any={`,
            "};",
            "}",
          ],
          unwrapValue(
            resolveType(
              constParentType,
              wrapSourceValue(fql([varName]), () =>
                Promise.resolve(fql([varName])),
              ),
              args,
            ),
          ),
          varIsErrorExpr(varNameType),
          Object.entries(branches).length
            ? fql(
                [
                  ...Object.keys(branches).map(
                    (concreteTypeName, i) =>
                      `${i > 0 ? "}else " : ""}if(${varNameType}==${JSON.stringify(concreteTypeName)}){`,
                  ),
                  "}else null",
                ],
                ...Object.values(branches).map(dataContainerAsQuery),
              )
            : fql`null`,
          chainVarErrorOrNull(
            `${varName}_result`,
            fql([
              `Object.assign(${varName}_result, {__typename:${varNameType}})`,
            ]),
          ),
        );
      };

      return Array.from(fieldNodes.entries()).flatMap(
        ([concreteType, onFieldNodes]) => {
          return onFieldNodes.map((fieldNode): ExpandedChild => {
            const key = (fieldNode.alias ?? fieldNode.name).value;
            return {
              fieldNode,
              concreteType,
              path,
              sourceValue: fql([varName]),
              setData: (data) => {
                (branches[concreteType.name] ??= {})[key] = unwrapValue(data);
                setDeferred(wrapQuery(getQuery()));
              },
            };
          });
        },
      );
    },
    getErrorMessage(value) {
      return (value as any)?.["@error"] ?? null;
    },
  };
}
