export class HttpResponse<V, S extends number> {
  readonly statusCode: S;
  readonly value: V;

  constructor(statusCode: S, value: V) {
    this.statusCode = statusCode;
    this.value = value;
  }
}

export class HttpCreated<V> extends HttpResponse<V, 201> {
  constructor(value: V) {
    super(201, value);
  }
}

export class HttpAccepted<V> extends HttpResponse<V, 202> {
  constructor(value: V) {
    super(202, value);
  }
}

export class HttpNoContent extends HttpResponse<void, 204> {
  constructor() {
    super(204, undefined as void);
  }
}
