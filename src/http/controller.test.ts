import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { controller } from "./controller.ts";
import type { Body } from "./routeTypes.ts";

class Greeter extends Context.Service<
  Greeter,
  { greet: (name: string) => string }
>()("Greeter") {}

const GreeterLive = Layer.succeed(Greeter, {
  greet: (name: string) => `hello ${name}`,
});

const greet = controller(
  ({ body }: Body<{ name: string }>) =>
    Effect.gen(function* () {
      const greeter = yield* Greeter;
      return { message: greeter.greet(body.name) };
    }),
  [GreeterLive],
);

describe("controller", () => {
  it("provides the declared layers to `Default`", async () => {
    const result = await Effect.runPromise(
      greet.Default({ body: { name: "ada" } }),
    );

    expect(result).toEqual({ message: "hello ada" });
  });

  it("leaves `DefaultWithoutDependencies` unprovided, for tests", async () => {
    const effect = greet.DefaultWithoutDependencies({ body: { name: "ada" } });

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.provideService(Greeter, { greet: (name) => `ciao ${name}` }),
      ),
    );

    expect(result).toEqual({ message: "ciao ada" });
  });

  it("accepts a controller with no layers at all", async () => {
    const ping = controller(() => Effect.succeed({ pong: true }));

    expect(await Effect.runPromise(ping.Default({}))).toEqual({ pong: true });
  });

  it("brands its output so hand-rolled objects are rejected", () => {
    const handWritten = {
      Default: () => Effect.succeed({}),
      DefaultWithoutDependencies: () => Effect.succeed({}),
    };

    const brand = Object.getOwnPropertySymbols(greet).find(
      (symbol) => symbol.toString() === "Symbol(brand/Controller)",
    );

    expect(brand).toBeDefined();
    expect(Object.getOwnPropertySymbols(handWritten)).toHaveLength(0);
    // @ts-expect-error — the brand is missing, so this is not a Controller.
    const _typeCheck: typeof greet = handWritten;
  });
});
