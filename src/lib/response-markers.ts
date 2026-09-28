/**
 * Carry the in-memory identity markers from one Response onto the one that replaces it.
 *
 * Several facts about a response are not in its status or headers, because the status would have
 * to lie to express them: whether this exchange is still replayable, whether the body is already
 * in the client's own wire, whether the client-side relay owns the completion, and whether the
 * socket death of this send is replaceable. Each is a WeakSet/WeakMap entry keyed on the Response
 * OBJECT, so every layer that rebuilds a Response -- an observation wrapper, a stream guard, a
 * formatter -- has to restate the ones it did not prove otherwise.
 *
 * Missing markers are not neutral: an unmarked body is treated as an ordinary, replayable
 * Responses stream by every helper above, and the observed failure mode is a chat-wire answer
 * being re-encoded as Responses SSE and a replay refusal being read as a plain 429.
 */
import {
  attachClientWireLog,
  clientWireLogOf,
  clientWireOf,
  markClientWire,
} from "../server/inference/client-wire";
import { carrySseResponseMarkers } from "../server/sse-response-markers";
import { carryCodexWsMarkers } from "../server/responses/codex-ws-wire";
import { carryNativeControlMarker } from "../server/responses/native-response-control";
import {
  carryReplayRefusal,
  isNonReplayableResponse,
  markResponseNonReplayable,
} from "./upstream-retry";

export function carryResponseMarkers<T extends Response>(source: Response, rewrapped: T): T {
  const wire = clientWireOf(source);
  if (wire) markClientWire(rewrapped, wire);
  const wireLog = clientWireLogOf(source);
  if (wireLog) attachClientWireLog(rewrapped, wireLog);
  if (isNonReplayableResponse(source)) markResponseNonReplayable(rewrapped);
  carrySseResponseMarkers(source, rewrapped);
  carryCodexWsMarkers(source, rewrapped);
  carryNativeControlMarker(source, rewrapped);
  return carryReplayRefusal(source, rewrapped);
}
