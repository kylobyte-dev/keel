import {
  Array,
  Cause,
  FiberId,
  HashMap,
  Inspectable,
  List,
  Logger,
  LogLevel,
} from "effect";
import type { FastifyBaseLogger } from "fastify";
import pino from "pino";

export const pinoInstance = pino({
  redact: ["headers.authorization"],
  transport: {
    target: "pino-pretty",
  },
});

export const PinoLogger = Logger.make<unknown, void>(
  ({ annotations, cause, date, fiberId, logLevel, message, spans }) => {
    if (logLevel._tag === "None") {
      return;
    }

    const now = date.getTime();
    const annotationsObj: Record<string, unknown> = {};
    const spansObj: Record<string, number> = {};

    if (HashMap.size(annotations) > 0) {
      for (const [key, value] of annotations) {
        annotationsObj[key] = structuredMessage(value);
      }
    }

    if (List.isCons(spans)) {
      for (const span of spans) {
        spansObj[span.label] = now - span.startTime;
      }
    }

    const messageArr = Array.ensure(message);

    const formattedMessage: string | undefined =
      messageArr.length === 0 ? undefined : structuredMessage(messageArr[0]);

    const data = {
      cause: Cause.isEmpty(cause)
        ? undefined
        : Cause.pretty(cause, { renderErrorCause: true }),
      annotations: annotationsObj,
      spans: spansObj,
      fiberId: FiberId.threadName(fiberId),
    };

    const logFn = logLevelMap[logLevel._tag];

    pinoInstance[logFn](data, formattedMessage);
  },
);

const structuredMessage = (value: unknown) => {
  switch (typeof value) {
    case "bigint":
    case "function":
    case "symbol": {
      return String(value);
    }
    default: {
      return Inspectable.toJSON(value) as string;
    }
  }
};

const logLevelMap = {
  All: "info",
  Debug: "debug",
  Error: "error",
  Fatal: "fatal",
  Info: "info",
  Trace: "trace",
  Warning: "warn",
} satisfies Record<
  Exclude<LogLevel.LogLevel["_tag"], "None">,
  keyof FastifyBaseLogger
>;
