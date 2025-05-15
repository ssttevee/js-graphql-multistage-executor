import {
  Client,
  type ClientConfig,
  errors,
  query as q,
  Expr,
  type ExprArg,
  type QueryOptions,
} from "faunadb";
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
  GraphQLCompositeOutputType,
  WrappedValue,
} from "../executor";
import { type Middleware, flattenMiddleware } from "../utils";
import type { ExpandedChild } from "../executor";

function isExpr(e: any) {
  return (
    e &&
    (e instanceof Expr ||
      Object.prototype.hasOwnProperty.call(e, "_isFaunaExpr"))
  );
}

const wrapped = Symbol("is wrapped");
const original = Symbol("get original");
export const isWrappedValue = (value: any): value is WrappedValue<any> =>
  Boolean(value?.[wrapped]);

export function unwrapValue(expr: any): any {
  expr = (expr as any)?.[wrapped] ? (expr as any)[original] : expr;

  if (isExpr(expr)) {
    expr.raw = unwrapValue(expr.raw);
    return expr;
  }

  if (Array.isArray(expr)) {
    return expr.map(unwrapValue);
  }

  if (expr && typeof expr === "object") {
    return Object.fromEntries(
      Object.entries(expr).map(([k, v]) => [k, unwrapValue(v)]),
    );
  }

  return expr;
}

function varIsErrorExpr(varName: string): Expr {
  return q.And(
    q.IsObject(q.Var(varName)),
    q.ContainsField("@error", q.Var(varName)),
  );
}

function wrapChildObject(varName: string, dataContainer: any, nullable = true) {
  return q.If(
    q.IsNull(q.Var(varName)),
    nullable ? null : { "@error": "Cannot return null for non-nullable field" },
    q.If(varIsErrorExpr(varName), q.Var(varName), dataContainer),
  );
}

export type QueryFunction = (
  client: Client,
  query: ExprArg,
  executionArgs: ExecutionArgs,
  options?: QueryOptions | undefined,
) => any;
export type TypeResolver = (
  abstractType: GraphQLAbstractType,
  value: Expr,
  executionArgs: ExecutionArgs,
) => Expr;

export type QueryMiddleware = Middleware<QueryFunction>;
export type TypeResolverMiddleware = Middleware<TypeResolver>;

export interface CreateExecutorBackendOptions {
  queryMiddleware?: QueryMiddleware | QueryMiddleware[];
  typeResolverMiddleware?: TypeResolverMiddleware | TypeResolverMiddleware[];
}

const realQuerySymbol = Symbol("real query");

async function defaultQueryFunction(
  client: Client,
  query: ExprArg,
  executionArgs: ExecutionArgs,
  options: QueryOptions | undefined,
) {
  if (
    executionArgs.contextValue &&
    typeof executionArgs.contextValue === "object"
  ) {
    (executionArgs.contextValue as any)[realQuerySymbol] = query;
  }

  return client.query(query, options);
}

function defaultTypeResolver(abstractType: GraphQLAbstractType, value: Expr) {
  return q.Select("__typename", value, {
    "@error": `failed to resolve type for ${abstractType.name}`,
  });
}

const nonnull = Symbol("nonnull");
const list = Symbol("list");

export default function createExecutorBackend(
  input?: ClientConfig | Client,
  options: CreateExecutorBackendOptions = {},
): ExecutorBackend<Expr> {
  const client = input instanceof Client ? input : new Client(input);

  const runQuery = flattenMiddleware(options.queryMiddleware)(
    defaultQueryFunction,
  );
  const resolveType = flattenMiddleware(options.typeResolverMiddleware)(
    defaultTypeResolver,
  );

  const wrapSourceValue = (
    sourceValue: unknown,
    getValue: () => Promise<unknown>,
  ) => {
    if (!(sourceValue instanceof Expr)) {
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

        if (typeof prop === "symbol" || prop === "toJSON") {
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

        return wrapSourceValue(q.Select(prop, sourceValue, null), async () =>
          Reflect.get((await getValue()) as any, prop),
        );
      },
      set: () => {
        throw new Error("cannot set properties on a execution placeholder");
      },
    });
  };

  return {
    resolveDeferredValues: async (input, executionArgs) => {
      const query = Array.from(input, ([expr]) => expr);
      const paths = Array.from(input, ([, path]) => pathToArray(path));
      try {
        return await runQuery(client, query, executionArgs);
      } catch (e) {
        if (
          !(e instanceof errors.FaunaHTTPError) ||
          !executionArgs.contextValue ||
          typeof executionArgs.contextValue !== "object"
        ) {
          throw e;
        }

        const rawQuery = JSON.parse(
          JSON.stringify((executionArgs.contextValue as any)[realQuerySymbol]),
        );

        throw Array.from(
          e.requestResult.responseContent.errors,
          (responseErr) => {
            const pathPrefix =
              paths[
                responseErr.position.find(
                  (pos) => typeof pos === "number",
                ) as number
              ];

            const objectPath: Array<string | number> = [];

            let faunapath = responseErr.position.slice(1);
            let objectpos: number;
            while ((objectpos = faunapath.indexOf("object")) !== -1) {
              faunapath = faunapath.slice(objectpos + 1);
              if (faunapath.length > 0) {
                objectPath.push(faunapath[0]);
              }
            }

            let errQuery = rawQuery;
            let cause: any = responseErr;
            if (responseErr.code === "call error") {
              for (const pos of responseErr.position) {
                errQuery = errQuery[pos];
              }

              responseErr.description = responseErr.description.replace(
                "the function",
                JSON.stringify(errQuery.call),
              );
              cause = responseErr.cause;
            } else {
              cause = { position: faunapath.slice(1) };
            }

            return new GraphQLError(
              `${responseErr.description}: ${JSON.stringify(cause)}`,
              {
                path: [...pathPrefix, ...objectPath],
              },
            );
          },
        );
      } finally {
        if (
          executionArgs.contextValue &&
          typeof executionArgs.contextValue === "object"
        ) {
          delete (executionArgs.contextValue as any)[realQuerySymbol];
        }
      }
    },
    isDeferredValue: (value: unknown): value is Expr => {
      return value instanceof Expr;
    },
    wrapSourceValue,
    isWrappedValue,
    unwrapResolvedValue: unwrapValue,
    expandChildren: (
      path: Path,
      parentValue: Expr,
      parentType: GraphQLCompositeOutputType,
      fieldNodes: Map<GraphQLObjectType, readonly FieldNode[]>,
      setDeferred: (data: Expr) => void,
      args: ExecutionArgs,
    ) => {
      const varName = pathToArray(path).join("_");
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

      let wrapQuery = (expr: ExprArg) => expr;
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
                (innerVarNameSaved, wrapQuerySaved, nullableSaved) => (expr) =>
                  q.Map(
                    q.Var(newVarName),
                    q.Lambda(
                      innerVarNameSaved,
                      wrapChildObject(
                        innerVarNameSaved,
                        wrapQuerySaved(expr),
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
          q.Let(
            { [innerVarName]: parentValue },
            wrapChildObject(innerVarName, wrapQuerySaved(query), nullable),
          )
      )(wrapQuery);

      const constParentType = parentType;
      if (isObjectType(constParentType)) {
        const dataContainer: Record<string, any> = {};
        const getQuery = () => dataContainer;

        return fieldNodes
          .get(constParentType)!
          .map((fieldNode): ExpandedChild => {
            const key = (fieldNode.alias ?? fieldNode.name).value;
            return {
              concreteType: constParentType,
              fieldNode,
              path,
              sourceValue: q.Var(varName),
              setData: (data) => {
                dataContainer[key] = unwrapValue(data);
                setDeferred(wrapQuery(getQuery()) as Expr);
              },
            };
          });
      }

      const branches: Record<string, Record<string, any>> = {};
      const getQuery = () => {
        const varNameType = `${varName}__typename`;
        return q.Let(
          {
            [varNameType]: unwrapValue(
              resolveType(
                constParentType,
                wrapSourceValue(q.Var(varName), () =>
                  Promise.resolve(q.Var(varName)),
                ),
                args,
              ),
            ),
          },
          q.If(
            varIsErrorExpr(varNameType),
            q.Var(varNameType),
            q.Let(
              {
                [`${varName}_result`]: Object.entries(
                  branches,
                ).reduce<ExprArg | null>(
                  (prev, [concreteTypeName, branch]) =>
                    q.If(
                      q.Equals(q.Var(varNameType), concreteTypeName),
                      branch,
                      prev,
                    ),
                  null,
                ),
              },
              wrapChildObject(
                `${varName}_result`,
                q.Merge(q.Var(`${varName}_result`), {
                  __typename: q.Var(varNameType),
                }),
              ),
            ),
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
              sourceValue: q.Var(varName),
              setData: (data) => {
                (branches[concreteType.name] ??= {})[key] = unwrapValue(data);
                setDeferred(wrapQuery(getQuery()) as Expr);
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
