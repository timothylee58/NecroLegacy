import type * as Api from "./generated/api";
import type * as Web from "../src/types/autopsy";

// The API always sends every key (null when empty) while the web types mark some keys optional,
// so optionality is normalized away before comparing; value types must still match exactly.
type Norm<T> = T extends readonly (infer U)[] ? Norm<U>[] : T extends object ? { [K in keyof T]-?: Norm<Exclude<T[K], undefined>> } : T;
type Mutual<A, B> = [Norm<A>] extends [Norm<B>] ? ([Norm<B>] extends [Norm<A>] ? true : false) : false;
const assertMutual = <_T extends true>() => undefined;

assertMutual<Mutual<Api.BoundingBox, Web.BoundingBox>>();
assertMutual<Mutual<Api.VisionCell, Web.VisionCell>>();
assertMutual<Mutual<Api.VisionDefect, Web.VisionDefect>>();
assertMutual<Mutual<Api.VisionResult, Web.VisionResult>>();
assertMutual<Mutual<Api.SchemaField, Web.SchemaField>>();
assertMutual<Mutual<Api.Entity, Web.Entity>>();
assertMutual<Mutual<Api.SchemaPayload, Web.SchemaPayload>>();
assertMutual<Mutual<Api.Anomaly, Web.Anomaly>>();
assertMutual<Mutual<Api.SpatialPoint, Web.SpatialPoint>>();
assertMutual<Mutual<Api.MlResult, Web.MlResult>>();
assertMutual<Mutual<Api.RotResult, Web.RotResult>>();
assertMutual<Mutual<Api.ResurrectionResult, Web.ResurrectionResult>>();
assertMutual<Mutual<Api.SearchHit, Web.SearchHit>>();
assertMutual<Mutual<Api.SearchResponse, Web.SearchResponse>>();
assertMutual<Mutual<Api.CreateSessionResponse, Web.CreateSessionResponse>>();
assertMutual<Mutual<Api.ErrorResponse, Web.ErrorResponse>>();
