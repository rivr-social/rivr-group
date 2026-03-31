import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vol } from 'memfs';
import { getEnv, getAllEnv, validateEnv } from '../env';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn((path: string, encoding: string) => {
    try {
      return vol.readFileSync(path, encoding);
    } catch {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
  }),
}));

describe('env.ts', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset process.env before each test
    process.env = { ...originalEnv };
    // Clear virtual filesystem
    vol.reset();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getEnv', () => {
    it('should return environment variable value when set', () => {
      // Arrange
      process.env.DATABASE_URL = 'postgresql://localhost/test';

      // Act
      const result = getEnv('DATABASE_URL');

      // Assert
      expect(result).toBe('postgresql://localhost/test');
    });

    it('should return default value when variable is not set', () => {
      // Arrange
      delete process.env.NODE_ENV;

      // Act
      const result = getEnv('NODE_ENV');

      // Assert
      expect(result).toBe('development');
    });

    it('should read from Docker secret file when _FILE variable is set', () => {
      // Arrange
      const secretPath = '/run/secrets/database_url';
      const secretValue = 'postgresql://secret-host/db';
      vol.fromJSON({
        [secretPath]: secretValue,
      });
      delete process.env.DATABASE_URL;
      process.env.DATABASE_URL_FILE = secretPath;

      // Act
      const result = getEnv('DATABASE_URL');

      // Assert
      expect(result).toBe(secretValue);
    });

    it('should trim whitespace from secret file content', () => {
      // Arrange
      const secretPath = '/run/secrets/api_key';
      const secretValue = '  my-secret-key\n';
      vol.fromJSON({
        [secretPath]: secretValue,
      });
      process.env.ANTHROPIC_API_KEY_FILE = secretPath;

      // Act
      const result = getEnv('ANTHROPIC_API_KEY');

      // Assert
      expect(result).toBe('my-secret-key');
    });

    it('should prefer direct env var over secret file', () => {
      // Arrange
      const secretPath = '/run/secrets/database_url';
      vol.fromJSON({
        [secretPath]: 'postgresql://secret/db',
      });
      process.env.DATABASE_URL = 'postgresql://direct/db';
      process.env.DATABASE_URL_FILE = secretPath;

      // Act
      const result = getEnv('DATABASE_URL');

      // Assert
      expect(result).toBe('postgresql://direct/db');
    });

    it('should handle missing secret file gracefully', () => {
      // Arrange
      process.env.DATABASE_URL_FILE = '/nonexistent/secret';
      delete process.env.DATABASE_URL;
      delete process.env.NODE_ENV; // Not in production

      // Act
      const result = getEnv('DATABASE_URL');

      // Assert
      expect(result).toBe('');
    });

    it('should throw error for missing required variable in production', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      delete process.env.DATABASE_URL_FILE;

      // Act & Assert
      expect(() => getEnv('DATABASE_URL')).toThrow(/Missing required environment variable/);
      expect(() => getEnv('DATABASE_URL')).toThrow(/DATABASE_URL/);
    });

    it('should not throw error for missing required variable in development', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;

      // Act
      const result = getEnv('DATABASE_URL');

      // Assert
      expect(result).toBe('');
    });

    it('should return default values for all defaulted variables', () => {
      // Arrange
      delete process.env.MINIO_ENDPOINT;
      delete process.env.MINIO_PORT;
      delete process.env.MINIO_USE_SSL;
      delete process.env.MINIO_BUCKET_UPLOADS;
      delete process.env.NEXTAUTH_URL;
      delete process.env.NODE_ENV;

      // Act & Assert
      expect(getEnv('NODE_ENV')).toBe('development');
      expect(getEnv('MINIO_ENDPOINT')).toBe('localhost');
      expect(getEnv('MINIO_PORT')).toBe('9000');
      expect(getEnv('MINIO_USE_SSL')).toBe('false');
      expect(getEnv('MINIO_BUCKET_UPLOADS')).toBe('rivr-uploads');
      expect(getEnv('NEXTAUTH_URL')).toBe('http://localhost:3000');
    });
  });

  describe('getAllEnv', () => {
    it('should return complete environment configuration', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/prod';
      process.env.MINIO_ACCESS_KEY = 'access-key';
      process.env.MINIO_SECRET_KEY = 'secret-key';
      process.env.AUTH_SECRET = 'auth-secret';
      process.env.MAPBOX_TOKEN = 'mapbox-token';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.STRIPE_SECRET_KEY = 'stripe-secret-key';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec-test';

      // Act
      const config = getAllEnv();

      // Assert
      expect(config).toMatchObject({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/prod',
        MINIO_ENDPOINT: 'localhost',
        MINIO_PORT: '9000',
        MINIO_ACCESS_KEY: 'access-key',
        MINIO_SECRET_KEY: 'secret-key',
        MINIO_USE_SSL: 'false',
        MINIO_BUCKET_UPLOADS: 'rivr-uploads',
        NEXTAUTH_URL: 'http://localhost:3000',
        MAPBOX_TOKEN: 'mapbox-token',
        ANTHROPIC_API_KEY: 'anthropic-key',
      });
    });

    it('should apply defaults for missing optional variables', () => {
      // Arrange
      delete process.env.NODE_ENV;
      delete process.env.MINIO_ENDPOINT;

      // Act
      const config = getAllEnv();

      // Assert
      expect(config.NODE_ENV).toBe('development');
      expect(config.MINIO_ENDPOINT).toBe('localhost');
    });
  });

  describe('validateEnv', () => {
    it('should not throw error when all required variables are set in production', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/prod';
      process.env.MINIO_ACCESS_KEY = 'access-key';
      process.env.MINIO_SECRET_KEY = 'secret-key';
      process.env.AUTH_SECRET = 'auth-secret';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.STRIPE_SECRET_KEY = 'stripe-secret-key';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec-test';

      // Act & Assert
      expect(() => validateEnv()).not.toThrow();
    });

    it('should throw error when required variable is missing in production', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      delete process.env.MINIO_ACCESS_KEY;

      // Act & Assert
      expect(() => validateEnv()).toThrow(/Missing required environment variables in production/);
      expect(() => validateEnv()).toThrow(/DATABASE_URL/);
      expect(() => validateEnv()).toThrow(/MINIO_ACCESS_KEY/);
    });

    it('should not throw error in development with missing variables', () => {
      // Arrange
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;
      delete process.env.MINIO_ACCESS_KEY;

      // Act & Assert
      expect(() => validateEnv()).not.toThrow();
    });

    it('should validate secret files in production', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      const secretPath = '/run/secrets/database_url';
      vol.fromJSON({
        [secretPath]: 'postgresql://localhost/prod',
      });
      process.env.DATABASE_URL_FILE = secretPath;
      process.env.MINIO_ACCESS_KEY = 'access-key';
      process.env.MINIO_SECRET_KEY = 'secret-key';
      process.env.AUTH_SECRET = 'auth-secret';
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';
      process.env.STRIPE_SECRET_KEY = 'stripe-secret-key';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec-test';

      // Act & Assert
      expect(() => validateEnv()).not.toThrow();
    });

    it('should list all missing required variables in error message', () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      delete process.env.MINIO_ACCESS_KEY;
      delete process.env.AUTH_SECRET;

      // Act
      let errorMessage = '';
      try {
        validateEnv();
      } catch (error) {
        errorMessage = (error as Error).message;
      }

      // Assert
      expect(errorMessage).toContain('DATABASE_URL');
      expect(errorMessage).toContain('MINIO_ACCESS_KEY');
      expect(errorMessage).toContain('AUTH_SECRET');
    });
  });

  describe('Docker secrets integration', () => {
    it('should read all required variables from secret files', () => {
      // Arrange
      const secrets = {
        '/run/secrets/database_url': 'postgresql://db-host/dbname',
        '/run/secrets/minio_access_key': 'minio-access',
        '/run/secrets/minio_secret_key': 'minio-secret',
        '/run/secrets/auth_secret': 'auth-secret-value',
        '/run/secrets/anthropic_api_key': 'anthropic-key',
      };

      vol.fromJSON(secrets);

      // Remove direct env vars so _FILE variants take precedence
      delete process.env.DATABASE_URL;
      delete process.env.MINIO_ACCESS_KEY;
      delete process.env.MINIO_SECRET_KEY;
      delete process.env.AUTH_SECRET;
      delete process.env.ANTHROPIC_API_KEY;

      process.env.DATABASE_URL_FILE = '/run/secrets/database_url';
      process.env.MINIO_ACCESS_KEY_FILE = '/run/secrets/minio_access_key';
      process.env.MINIO_SECRET_KEY_FILE = '/run/secrets/minio_secret_key';
      process.env.AUTH_SECRET_FILE = '/run/secrets/auth_secret';
      process.env.ANTHROPIC_API_KEY_FILE = '/run/secrets/anthropic_api_key';

      // Act
      const config = getAllEnv();

      // Assert
      expect(config.DATABASE_URL).toBe('postgresql://db-host/dbname');
      expect(config.MINIO_ACCESS_KEY).toBe('minio-access');
      expect(config.MINIO_SECRET_KEY).toBe('minio-secret');
      expect(config.AUTH_SECRET).toBe('auth-secret-value');
      expect(config.ANTHROPIC_API_KEY).toBe('anthropic-key');
    });

    it('should handle mixed direct and secret file variables', () => {
      // Arrange
      const secretPath = '/run/secrets/database_url';
      vol.fromJSON({
        [secretPath]: 'postgresql://secret-host/db',
      });

      // Remove direct DATABASE_URL so _FILE variant takes precedence
      delete process.env.DATABASE_URL;
      process.env.DATABASE_URL_FILE = secretPath;
      process.env.MINIO_ACCESS_KEY = 'direct-access-key';
      process.env.MINIO_ENDPOINT = 'custom-endpoint';

      // Act
      const config = getAllEnv();

      // Assert
      expect(config.DATABASE_URL).toBe('postgresql://secret-host/db');
      expect(config.MINIO_ACCESS_KEY).toBe('direct-access-key');
      expect(config.MINIO_ENDPOINT).toBe('custom-endpoint');
    });
  });
});
