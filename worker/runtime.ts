export interface RuntimeBindings {
  database: D1Database;
  secretKey: string;
  accessTokenExpireMinutes: number;
  refreshTokenExpireMinutes: number;
  openaiApiKey?: string;
  openaiNormalizationModel: string;
  posIdleTimeoutSeconds: number;
  posSessionExpireHours: number;
  posLoginMaxAttempts: number;
  posLoginLockMinutes: number;
}

export interface VoiceRuntimeBindings extends RuntimeBindings {
  voiceAudio: R2Bucket;
  environment: string;
  retentionHours: number;
  maxAudioChunkBytes: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function voiceRuntimeBindings(env: Env): VoiceRuntimeBindings | null {
  const base = runtimeBindings(env);
  if (base === null || env.VOICE_AUDIO === undefined) return null;
  return {
    ...base,
    voiceAudio: env.VOICE_AUDIO,
    environment: env.APP_ENVIRONMENT,
    retentionHours: positiveInteger(env.VOICE_AUDIO_RETENTION_HOURS, 24),
    maxAudioChunkBytes: positiveInteger(env.VOICE_AUDIO_MAX_CHUNK_BYTES, 8 * 1024 * 1024),
  };
}

export function runtimeBindings(env: Env): RuntimeBindings | null {
  if (env.DB === undefined || env.SECRET_KEY === undefined || env.SECRET_KEY.length === 0) {
    return null;
  }
  const optionalEnv=env as Env & { OPENAI_API_KEY?: string; OPENAI_NORMALIZATION_MODEL?: string };
  return {
    database: env.DB,
    secretKey: env.SECRET_KEY,
    accessTokenExpireMinutes: positiveInteger(env.ACCESS_TOKEN_EXPIRE_MINUTES, 60),
    refreshTokenExpireMinutes: positiveInteger(
      env.REFRESH_TOKEN_EXPIRE_MINUTES,
      60 * 24 * 7,
    ),
    openaiApiKey: optionalEnv.OPENAI_API_KEY,
    openaiNormalizationModel: optionalEnv.OPENAI_NORMALIZATION_MODEL ?? "gpt-5.6-luna",
    posIdleTimeoutSeconds: positiveInteger(env.POS_IDLE_TIMEOUT_SECONDS, 45),
    posSessionExpireHours: positiveInteger(env.POS_SESSION_EXPIRE_HOURS, 12),
    posLoginMaxAttempts: positiveInteger(env.POS_LOGIN_MAX_ATTEMPTS, 5),
    posLoginLockMinutes: positiveInteger(env.POS_LOGIN_LOCK_MINUTES, 5),
  };
}
