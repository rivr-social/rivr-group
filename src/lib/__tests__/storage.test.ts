import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  uploadFile,
  uploadFiles,
  resetS3Client,
  StorageError,
  FileSizeError,
  InvalidMimeTypeError,
} from '../storage';

// Mock the env module
vi.mock('../env', () => ({
  getEnv: vi.fn((key: string) => {
    const mockEnv: Record<string, string> = {
      MINIO_ENDPOINT: 'localhost',
      MINIO_PORT: '9000',
      MINIO_ACCESS_KEY: 'test-access-key',
      MINIO_SECRET_KEY: 'test-secret-key',
      MINIO_USE_SSL: 'false',
      MINIO_BUCKET_UPLOADS: 'rivr-uploads',
      MINIO_BUCKET_AVATARS: 'rivr-avatars',
      MINIO_BUCKET_EXPORTS: 'rivr-exports',
    };
    return mockEnv[key] || '';
  }),
}));

const s3Mock = mockClient(S3Client);

describe('storage.ts', () => {
  beforeEach(() => {
    s3Mock.reset();
    resetS3Client();
    vi.clearAllMocks();
    delete process.env.ASSET_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_MINIO_URL;
    delete process.env.NEXT_PUBLIC_DOMAIN;
  });

  describe('uploadFile', () => {
    it('should successfully upload a valid image file', async () => {
      // Arrange
      const buffer = Buffer.from('fake-image-data');
      const filename = 'test-image.jpg';
      const mimeType = 'image/jpeg';

      s3Mock.on(PutObjectCommand).resolves({});

      // Act
      const result = await uploadFile(buffer, filename, mimeType);

      // Assert
      expect(result).toMatchObject({
        bucket: 'rivr-uploads',
        size: buffer.length,
        mimeType: 'image/jpeg',
      });
      expect(result.key).toMatch(/^uploads\/\d+-[a-z0-9]+-test-image\.jpg$/);
      expect(result.url).toMatch(/^http:\/\/localhost:9000\/rivr-uploads\/uploads\//);
      expect(result.timestamp).toBeGreaterThan(0);

      // Verify S3 command was called
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        Bucket: 'rivr-uploads',
        ContentType: 'image/jpeg',
        ContentLength: buffer.length,
      });
    });

    it('should upload PDF files', async () => {
      // Arrange
      const buffer = Buffer.from('fake-pdf-data');
      const filename = 'document.pdf';
      const mimeType = 'application/pdf';

      s3Mock.on(PutObjectCommand).resolves({});

      // Act
      const result = await uploadFile(buffer, filename, mimeType);

      // Assert
      expect(result.mimeType).toBe('application/pdf');
      expect(result.key).toContain('document.pdf');
    });

    it('should sanitize filenames with special characters', async () => {
      // Arrange
      const buffer = Buffer.from('test-data');
      const filename = 'my file (copy) #1.jpg';
      const mimeType = 'image/jpeg';

      s3Mock.on(PutObjectCommand).resolves({});

      // Act
      const result = await uploadFile(buffer, filename, mimeType);

      // Assert
      expect(result.key).toMatch(/my_file__copy___1\.jpg$/);
    });

    it('should throw FileSizeError for files exceeding maximum size', async () => {
      // Arrange
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
      const filename = 'large-file.jpg';
      const mimeType = 'image/jpeg';

      // Act & Assert
      await expect(uploadFile(largeBuffer, filename, mimeType)).rejects.toThrow(FileSizeError);
      await expect(uploadFile(largeBuffer, filename, mimeType)).rejects.toThrow(
        /exceeds maximum allowed size/
      );
    });

    it('should throw InvalidMimeTypeError for disallowed MIME types', async () => {
      // Arrange
      const buffer = Buffer.from('test-data');
      const filename = 'script.js';
      const mimeType = 'application/javascript';

      // Act & Assert
      await expect(uploadFile(buffer, filename, mimeType)).rejects.toThrow(InvalidMimeTypeError);
      await expect(uploadFile(buffer, filename, mimeType)).rejects.toThrow(/is not allowed/);
    });

    it('should allow all supported MIME types', async () => {
      // Arrange
      const buffer = Buffer.from('test-data');
      const supportedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'application/pdf',
        'text/csv',
        'application/json',
      ];

      s3Mock.on(PutObjectCommand).resolves({});

      // Act & Assert
      for (const mimeType of supportedTypes) {
        const result = await uploadFile(buffer, `test.${mimeType.split('/')[1]}`, mimeType);
        expect(result.mimeType).toBe(mimeType);
      }
    });

    it('should throw StorageError when S3 upload fails', async () => {
      // Arrange
      const buffer = Buffer.from('test-data');
      const filename = 'test.jpg';
      const mimeType = 'image/jpeg';

      s3Mock.on(PutObjectCommand).rejects(new Error('Network error'));

      // Act & Assert
      await expect(uploadFile(buffer, filename, mimeType)).rejects.toThrow(StorageError);
      await expect(uploadFile(buffer, filename, mimeType)).rejects.toThrow(
        /Failed to upload file to storage/
      );
    });

    it('should generate unique keys for identical filenames', async () => {
      // Arrange
      const buffer = Buffer.from('test-data');
      const filename = 'test.jpg';
      const mimeType = 'image/jpeg';

      s3Mock.on(PutObjectCommand).resolves({});

      // Act
      const result1 = await uploadFile(buffer, filename, mimeType);
      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result2 = await uploadFile(buffer, filename, mimeType);

      // Assert
      expect(result1.key).not.toBe(result2.key);
    });

    it('should generate correct URL with SSL enabled', async () => {
      // Arrange
      const { getEnv } = await import('../env');
      (getEnv as Mock).mockImplementation((key: string) => {
        const mockEnv: Record<string, string> = {
          MINIO_ENDPOINT: 'minio.example.com',
          MINIO_PORT: '443',
          MINIO_ACCESS_KEY: 'test-key',
          MINIO_SECRET_KEY: 'test-secret',
          MINIO_USE_SSL: 'true',
          MINIO_BUCKET_UPLOADS: 'rivr-uploads',
          MINIO_BUCKET_AVATARS: 'rivr-avatars',
          MINIO_BUCKET_EXPORTS: 'rivr-exports',
        };
        return mockEnv[key] || '';
      });
      resetS3Client();

      const buffer = Buffer.from('test-data');
      const filename = 'test.jpg';
      const mimeType = 'image/jpeg';

      s3Mock.on(PutObjectCommand).resolves({});

      // Act
      const result = await uploadFile(buffer, filename, mimeType);

      // Assert
      expect(result.url).toMatch(/^https:\/\/minio\.example\.com:443\/rivr-uploads\//);
    });

    it('should prefer ASSET_PUBLIC_BASE_URL when provided', async () => {
      process.env.ASSET_PUBLIC_BASE_URL = 'https://s3.example.com';
      const buffer = Buffer.from('test-data');
      const filename = 'avatar.png';
      const mimeType = 'image/png';

      s3Mock.on(PutObjectCommand).resolves({});
      const result = await uploadFile(buffer, filename, mimeType, 'avatars');

      expect(result.url).toMatch(/^https:\/\/s3\.example\.com\/rivr-avatars\//);
    });

    it('should derive public S3 domain from NEXT_PUBLIC_DOMAIN', async () => {
      process.env.NEXT_PUBLIC_DOMAIN = 'rivr.app';
      const buffer = Buffer.from('test-data');
      const filename = 'cover.jpg';
      const mimeType = 'image/jpeg';

      s3Mock.on(PutObjectCommand).resolves({});
      const result = await uploadFile(buffer, filename, mimeType, 'avatars');

      expect(result.url).toMatch(/^https:\/\/s3\.rivr\.app\/rivr-avatars\//);
    });
  });

  describe('uploadFiles', () => {
    it('should upload multiple files in parallel', async () => {
      // Arrange
      const files = [
        { buffer: Buffer.from('data1'), filename: 'file1.jpg', mimeType: 'image/jpeg' },
        { buffer: Buffer.from('data2'), filename: 'file2.png', mimeType: 'image/png' },
        { buffer: Buffer.from('data3'), filename: 'file3.pdf', mimeType: 'application/pdf' },
      ];

      s3Mock.on(PutObjectCommand).resolves({});

      // Act
      const results = await uploadFiles(files);

      // Assert
      expect(results).toHaveLength(3);
      expect(results[0].key).toContain('file1.jpg');
      expect(results[1].key).toContain('file2.png');
      expect(results[2].key).toContain('file3.pdf');

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(3);
    });

    it('should throw StorageError if any upload fails', async () => {
      // Arrange
      const files = [
        { buffer: Buffer.from('data1'), filename: 'file1.jpg', mimeType: 'image/jpeg' },
        { buffer: Buffer.from('data2'), filename: 'file2.png', mimeType: 'image/png' },
      ];

      s3Mock
        .on(PutObjectCommand)
        .resolvesOnce({})
        .rejectsOnce(new Error('Upload failed'));

      // Act & Assert - single call to avoid consuming mock responses twice
      const promise = uploadFiles(files);
      await expect(promise).rejects.toThrow(StorageError);

      // Reset mock and re-run for message check
      s3Mock.reset();
      resetS3Client();
      s3Mock
        .on(PutObjectCommand)
        .resolvesOnce({})
        .rejectsOnce(new Error('Upload failed'));

      await expect(uploadFiles(files)).rejects.toThrow(/Failed to upload one or more files/);
    });

    it('should handle empty array of files', async () => {
      // Arrange
      const files: Array<{ buffer: Buffer; filename: string; mimeType: string }> = [];

      // Act
      const results = await uploadFiles(files);

      // Assert
      expect(results).toHaveLength(0);
    });
  });

  describe('Error classes', () => {
    it('should create FileSizeError with detailed message', () => {
      // Arrange & Act
      const error = new FileSizeError(15000000, 10000000);

      // Assert
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('FileSizeError');
      expect(error.message).toContain('15000000 bytes');
      expect(error.message).toContain('10000000 bytes');
    });

    it('should create InvalidMimeTypeError with allowed types', () => {
      // Arrange & Act
      const error = new InvalidMimeTypeError('application/javascript', [
        'image/jpeg',
        'image/png',
      ]);

      // Assert
      expect(error).toBeInstanceOf(StorageError);
      expect(error.name).toBe('InvalidMimeTypeError');
      expect(error.message).toContain('application/javascript');
      expect(error.message).toContain('image/jpeg, image/png');
    });

    it('should create StorageError with cause', () => {
      // Arrange
      const originalError = new Error('Original error');

      // Act
      const error = new StorageError('Storage failed', originalError);

      // Assert
      expect(error.name).toBe('StorageError');
      expect(error.message).toBe('Storage failed');
      expect(error.cause).toBe(originalError);
    });
  });
});
