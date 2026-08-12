export type UserRole = "ADMIN" | "MANAGER" | "SERVER";

export interface UserRecord {
  id: number;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  employee_id: number | null;
  created_at: string;
  updated_at: string;
}

const USER_COLUMNS = `
  id, email, password_hash, full_name, role, employee_id,
  created_at, updated_at
`;

export class UserRepository {
  constructor(private readonly database: D1Database) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.database
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ? LIMIT 1`)
      .bind(email)
      .first<UserRecord>();
  }

  async findById(id: number): Promise<UserRecord | null> {
    return this.database
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<UserRecord>();
  }

  async create(input: {
    email: string;
    passwordHash: string;
    fullName: string;
    role: UserRole;
  }): Promise<UserRecord> {
    const user = await this.database
      .prepare(
        `INSERT INTO users
         (email, password_hash, full_name, role, employee_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING ${USER_COLUMNS}`,
      )
      .bind(input.email, input.passwordHash, input.fullName, input.role)
      .first<UserRecord>();
    if (user === null) throw new Error("User insert did not return a row");
    return user;
  }
}

function serializeDateTime(value: string): string {
  return value.includes("T") ? value : value.replace(" ", "T");
}

export function serializeUser(user: UserRecord): Record<string, unknown> {
  return {
    created_at: serializeDateTime(user.created_at),
    updated_at: serializeDateTime(user.updated_at),
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    employee_id: user.employee_id,
  };
}
