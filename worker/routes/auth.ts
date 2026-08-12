import { apiError, jsonResponse, validationError } from "../http";
import {
  serializeUser,
  UserRepository,
  type UserRecord,
  type UserRole,
} from "../repositories/users";
import type { RuntimeBindings } from "../runtime";
import { createToken, verifyToken } from "../security/jwt";
import { hashPassword, verifyPassword } from "../security/passwords";

interface LoginFields {
  email: string;
  password: string;
}

interface RegistrationFields extends LoginFields {
  full_name: string;
  role: UserRole;
}

interface AuthenticationResult {
  user: UserRecord | null;
  response: Response | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emailReason(value: string): string | null {
  const candidate = value.trim();
  if (!candidate.includes("@")) return "An email address must have an @-sign.";
  const [local, domain, ...rest] = candidate.split("@");
  if (local.length === 0) return "There must be something before the @-sign.";
  if (domain.length === 0 || rest.length > 0) return "The part after the @-sign is not valid.";
  if (!domain.includes(".")) return "The part after the @-sign is not valid. It should have a period.";
  return null;
}

function normalizeEmail(value: string): string {
  const candidate = value.trim();
  const separator = candidate.lastIndexOf("@");
  return `${candidate.slice(0, separator)}@${candidate.slice(separator + 1).toLowerCase()}`;
}

function loginValidationErrors(input: unknown): Array<Record<string, unknown>> {
  const values = isObject(input) ? input : {};
  const errors: Array<Record<string, unknown>> = [];
  for (const field of ["email", "password"] as const) {
    if (!(field in values)) {
      errors.push({
        type: "missing",
        loc: ["body", field],
        msg: "Field required",
        input,
      });
    } else if (typeof values[field] !== "string") {
      errors.push({
        type: "string_type",
        loc: ["body", field],
        msg: "Input should be a valid string",
        input: values[field],
      });
    }
  }

  if (typeof values.email === "string") {
    const reason = emailReason(values.email);
    if (reason !== null) {
      errors.push({
        type: "value_error",
        loc: ["body", "email"],
        msg: `value is not a valid email address: ${reason}`,
        input: values.email,
        ctx: { reason },
      });
    }
  }
  return errors;
}

async function jsonLoginFields(request: Request): Promise<LoginFields | Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return validationError(request, [
      {
        type: "json_invalid",
        loc: ["body", 0],
        msg: "JSON decode error",
        input: {},
        ctx: { error: "Invalid JSON" },
      },
    ]);
  }
  const errors = loginValidationErrors(input);
  if (errors.length > 0) return validationError(request, errors);
  if (
    !isObject(input) ||
    typeof input.email !== "string" ||
    typeof input.password !== "string"
  ) {
    return validationError(request, errors);
  }
  return { email: normalizeEmail(input.email), password: input.password };
}

async function registrationFields(request: Request): Promise<RegistrationFields | Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return validationError(request, [{
      type: "json_invalid",
      loc: ["body", 0],
      msg: "JSON decode error",
      input: {},
      ctx: { error: "Invalid JSON" },
    }]);
  }

  const values = isObject(input) ? input : {};
  const errors = loginValidationErrors(input);
  if (!("full_name" in values)) {
    errors.push({ type: "missing", loc: ["body", "full_name"], msg: "Field required", input });
  } else if (typeof values.full_name !== "string") {
    errors.push({
      type: "string_type",
      loc: ["body", "full_name"],
      msg: "Input should be a valid string",
      input: values.full_name,
    });
  }
  if (typeof values.password === "string" && values.password.length < 6) {
    errors.push({
      type: "string_too_short",
      loc: ["body", "password"],
      msg: "String should have at least 6 characters",
      input: values.password,
      ctx: { min_length: 6 },
    });
  }
  const role = "role" in values ? values.role : "SERVER";
  if (typeof role !== "string" || !(["ADMIN", "MANAGER", "SERVER"] as const).includes(role as UserRole)) {
    errors.push({
      type: "enum",
      loc: ["body", "role"],
      msg: "Input should be 'ADMIN', 'MANAGER' or 'SERVER'",
      input: role,
      ctx: { expected: "'ADMIN', 'MANAGER' or 'SERVER'" },
    });
  }
  if (errors.length > 0) return validationError(request, errors);
  if (
    typeof values.email !== "string" ||
    typeof values.password !== "string" ||
    typeof values.full_name !== "string" ||
    typeof role !== "string"
  ) {
    return validationError(request, errors);
  }
  return {
    email: normalizeEmail(values.email),
    password: values.password,
    full_name: values.full_name,
    role: role as UserRole,
  };
}

async function formLoginFields(request: Request): Promise<LoginFields | Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    form = new FormData();
  }
  const username = form.get("username");
  const password = form.get("password");
  const errors: Array<Record<string, unknown>> = [];
  if (typeof username !== "string") {
    errors.push({
      type: "missing",
      loc: ["body", "username"],
      msg: "Field required",
      input: null,
    });
  }
  if (typeof password !== "string") {
    errors.push({
      type: "missing",
      loc: ["body", "password"],
      msg: "Field required",
      input: null,
    });
  }
  if (errors.length > 0) return validationError(request, errors);
  if (typeof username !== "string" || typeof password !== "string") {
    return validationError(request, errors);
  }
  return { email: username, password };
}

function authCookies(
  request: Request,
  accessToken: string,
  refreshToken: string,
  bindings: RuntimeBindings,
): string[] {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return [
    `tss_access_token=${accessToken}; HttpOnly; Max-Age=${bindings.accessTokenExpireMinutes * 60}; Path=/; SameSite=lax${secure}`,
    `tss_refresh_token=${refreshToken}; HttpOnly; Max-Age=${bindings.refreshTokenExpireMinutes * 60}; Path=/; SameSite=lax${secure}`,
  ];
}

function tokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization);
    if (match !== null) return match[1];
  }
  const cookieHeader = request.headers.get("Cookie");
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === "tss_access_token") {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

export async function authenticateRequest(
  request: Request,
  bindings: RuntimeBindings,
): Promise<AuthenticationResult> {
  const token = tokenFromRequest(request);
  const userId = token === null ? null : await verifyToken(token, bindings.secretKey);
  const user = userId === null ? null : await new UserRepository(bindings.database).findById(userId);
  if (user === null) {
    return {
      user: null,
      response: apiError(request, 401, "Could not validate credentials", {
        "WWW-Authenticate": "Bearer",
      }),
    };
  }
  return { user, response: null };
}

export function requireManagerOrAdmin(request: Request, role: UserRole): Response | null {
  return role === "ADMIN" || role === "MANAGER"
    ? null
    : apiError(request, 403, "Insufficient permissions");
}

async function loginResponse(
  request: Request,
  fields: LoginFields,
  bindings: RuntimeBindings,
): Promise<Response> {
  const user = await new UserRepository(bindings.database).findByEmail(fields.email);
  if (user === null || !(await verifyPassword(fields.password, user.password_hash))) {
    return apiError(request, 401, "Incorrect email or password");
  }

  const [accessToken, refreshToken] = await Promise.all([
    createToken(user.id, bindings.secretKey, bindings.accessTokenExpireMinutes),
    createToken(user.id, bindings.secretKey, bindings.refreshTokenExpireMinutes),
  ]);
  const headers = new Headers();
  for (const cookie of authCookies(request, accessToken, refreshToken, bindings)) {
    headers.append("Set-Cookie", cookie);
  }
  return jsonResponse(
    request,
    { access_token: accessToken, refresh_token: refreshToken, token_type: "bearer" },
    { headers },
  );
}

export async function loginJson(
  request: Request,
  bindings: RuntimeBindings,
): Promise<Response> {
  const fields = await jsonLoginFields(request);
  return fields instanceof Response ? fields : loginResponse(request, fields, bindings);
}

export async function register(
  request: Request,
  bindings: RuntimeBindings,
): Promise<Response> {
  const fields = await registrationFields(request);
  if (fields instanceof Response) return fields;

  const repository = new UserRepository(bindings.database);
  if (await repository.findByEmail(fields.email)) {
    return apiError(request, 400, "Email already registered");
  }

  let user: UserRecord;
  try {
    user = await repository.create({
      email: fields.email,
      passwordHash: await hashPassword(fields.password),
      fullName: fields.full_name,
      role: fields.role,
    });
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      return apiError(request, 400, "Email already registered");
    }
    throw error;
  }

  const [accessToken, refreshToken] = await Promise.all([
    createToken(user.id, bindings.secretKey, bindings.accessTokenExpireMinutes),
    createToken(user.id, bindings.secretKey, bindings.refreshTokenExpireMinutes),
  ]);
  const headers = new Headers();
  for (const cookie of authCookies(request, accessToken, refreshToken, bindings)) {
    headers.append("Set-Cookie", cookie);
  }
  return jsonResponse(request, serializeUser(user), { status: 201, headers });
}

export async function loginToken(
  request: Request,
  bindings: RuntimeBindings,
): Promise<Response> {
  const fields = await formLoginFields(request);
  return fields instanceof Response ? fields : loginResponse(request, fields, bindings);
}

export async function currentUser(
  request: Request,
  bindings: RuntimeBindings,
): Promise<Response> {
  const authentication = await authenticateRequest(request, bindings);
  if (authentication.response !== null) return authentication.response;
  if (authentication.user === null) {
    return apiError(request, 401, "Could not validate credentials", {
      "WWW-Authenticate": "Bearer",
    });
  }
  return jsonResponse(request, serializeUser(authentication.user));
}

export function logout(request: Request): Response {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const headers = new Headers();
  for (const name of ["tss_access_token", "tss_refresh_token"]) {
    headers.append(
      "Set-Cookie",
      `${name}=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=lax${secure}`,
    );
  }
  return new Response(null, { status: 204, headers });
}
