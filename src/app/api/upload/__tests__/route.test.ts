import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import { NextRequest } from 'next/server';

// Mock auth module
const mockAuth = vi.fn();
vi.mock('@/auth', () => ({
  auth: () => mockAuth(),
}));

// Mock storage module
const mockUploadFile = vi.fn();
vi.mock('@/lib/storage', () => ({
  uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  StorageError: class StorageError extends Error {
    name = 'StorageError';
    constructor(message: string, public readonly cause?: unknown) {
      super(message);
    }
  },
  FileSizeError: class FileSizeError extends Error {
    name = 'FileSizeError';
    constructor(public readonly size: number, public readonly maxSize: number) {
      super(`File size ${size} bytes exceeds maximum allowed size of ${maxSize} bytes`);
    }
  },
  InvalidMimeTypeError: class InvalidMimeTypeError extends Error {
    name = 'InvalidMimeTypeError';
    constructor(public readonly mimeType: string, public readonly allowedTypes: string[]) {
      super(`MIME type ${mimeType} is not allowed. Allowed types: ${allowedTypes.join(', ')}`);
    }
  },
}));

function createFileFormData(
  files: Array<{ name: string; content: string; type: string }>
): FormData {
  const formData = new FormData();
  for (const file of files) {
    const blob = new Blob([file.content], { type: file.type });
    formData.append('file', blob, file.name);
  }
  return formData;
}

function createRequest(formData: FormData): NextRequest {
  return new NextRequest('http://localhost:3000/api/upload', {
    method: 'POST',
    body: formData,
  });
}

describe('POST /api/upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('authentication', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockAuth.mockResolvedValue(null);

      const formData = createFileFormData([
        { name: 'test.jpg', content: 'fake-image', type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Authentication required');
    });

    it('should return 401 when session has no user id', async () => {
      mockAuth.mockResolvedValue({ user: {} });

      const formData = createFileFormData([
        { name: 'test.jpg', content: 'fake-image', type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('input validation', () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: 'user1' } });
    });

    it('should return 400 when no files are provided', async () => {
      const formData = new FormData();
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('No files provided');
    });

    it('should return 400 when more than 10 files are uploaded', async () => {
      const files = Array.from({ length: 11 }, (_, i) => ({
        name: `file-${i}.jpg`,
        content: 'data',
        type: 'image/jpeg',
      }));
      const formData = createFileFormData(files);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Too many files');
    });
  });

  describe('successful uploads', () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: 'user1' } });
    });

    it('should upload a single file and return result', async () => {
      const mockResult = {
        key: 'uploads/123-abc-test.jpg',
        url: 'http://localhost:9000/public-assets/uploads/123-abc-test.jpg',
        bucket: 'public-assets',
        size: 10,
        mimeType: 'image/jpeg',
        timestamp: Date.now(),
      };
      mockUploadFile.mockResolvedValue(mockResult);

      const formData = createFileFormData([
        { name: 'test.jpg', content: 'fake-image', type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results).toHaveLength(1);
      expect(body.results[0]).toEqual(mockResult);
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
    });

    it('should upload multiple files and return all results', async () => {
      mockUploadFile
        .mockResolvedValueOnce({
          key: 'uploads/1-a-file1.jpg',
          url: 'http://localhost:9000/public-assets/uploads/1-a-file1.jpg',
          bucket: 'public-assets',
          size: 5,
          mimeType: 'image/jpeg',
          timestamp: Date.now(),
        })
        .mockResolvedValueOnce({
          key: 'uploads/2-b-file2.png',
          url: 'http://localhost:9000/public-assets/uploads/2-b-file2.png',
          bucket: 'public-assets',
          size: 8,
          mimeType: 'image/png',
          timestamp: Date.now(),
        });

      const formData = createFileFormData([
        { name: 'file1.jpg', content: 'data1', type: 'image/jpeg' },
        { name: 'file2.png', content: 'data2data', type: 'image/png' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results).toHaveLength(2);
      expect(mockUploadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe('bucket selection', () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: 'user1' } });
      mockUploadFile.mockResolvedValue({
        key: 'uploads/123-abc-test.jpg',
        url: 'http://localhost:9000/rivr-uploads/uploads/123-abc-test.jpg',
        bucket: 'rivr-uploads',
        size: 10,
        mimeType: 'image/jpeg',
        timestamp: Date.now(),
      });
    });

    it('should pass undefined bucket when no bucket field is provided', async () => {
      const formData = createFileFormData([
        { name: 'test.jpg', content: 'data', type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockUploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        'test.jpg',
        'image/jpeg',
        undefined
      );
    });

    it('should pass "avatars" bucket when specified', async () => {
      const formData = createFileFormData([
        { name: 'avatar.jpg', content: 'data', type: 'image/jpeg' },
      ]);
      formData.append('bucket', 'avatars');
      const request = createRequest(formData);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockUploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        'avatar.jpg',
        'image/jpeg',
        'avatars'
      );
    });

    it('should pass "exports" bucket when specified', async () => {
      const formData = createFileFormData([
        { name: 'data.csv', content: 'a,b,c', type: 'text/csv' },
      ]);
      formData.append('bucket', 'exports');
      const request = createRequest(formData);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockUploadFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        'data.csv',
        'text/csv',
        'exports'
      );
    });

    it('should return 400 for invalid bucket name', async () => {
      const formData = createFileFormData([
        { name: 'test.jpg', content: 'data', type: 'image/jpeg' },
      ]);
      formData.append('bucket', 'nonexistent');
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid bucket');
      expect(body.error).toContain('nonexistent');
    });
  });

  describe('storage errors', () => {
    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: 'user1' } });
    });

    it('should return 413 when file exceeds size limit', async () => {
      const { FileSizeError } = await import('@/lib/storage');
      mockUploadFile.mockRejectedValue(new FileSizeError(15000000, 10000000));

      const formData = createFileFormData([
        { name: 'large.jpg', content: 'x'.repeat(100), type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toContain('exceeds maximum');
      expect(body.file).toBe('large.jpg');
    });

    it('should return 415 for unsupported MIME type', async () => {
      const { InvalidMimeTypeError } = await import('@/lib/storage');
      mockUploadFile.mockRejectedValue(
        new InvalidMimeTypeError('application/javascript', ['image/jpeg', 'image/png'])
      );

      const formData = createFileFormData([
        { name: 'script.js', content: 'code', type: 'application/javascript' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(415);
      expect(body.error).toContain('not allowed');
      expect(body.file).toBe('script.js');
    });

    it('should return 500 for general storage errors', async () => {
      const { StorageError } = await import('@/lib/storage');
      mockUploadFile.mockRejectedValue(new StorageError('S3 connection failed'));

      const formData = createFileFormData([
        { name: 'test.jpg', content: 'data', type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Upload failed');
      expect(body.error).toContain('test.jpg');
    });

    it('should return 500 for unexpected errors', async () => {
      mockUploadFile.mockRejectedValue(new Error('something unexpected'));

      const formData = createFileFormData([
        { name: 'test.jpg', content: 'data', type: 'image/jpeg' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Unexpected error');
    });

    it('should stop at first file error in multi-file upload', async () => {
      const { InvalidMimeTypeError } = await import('@/lib/storage');
      mockUploadFile
        .mockResolvedValueOnce({
          key: 'uploads/1-a-ok.jpg',
          url: 'http://localhost:9000/public-assets/uploads/1-a-ok.jpg',
          bucket: 'public-assets',
          size: 4,
          mimeType: 'image/jpeg',
          timestamp: Date.now(),
        })
        .mockRejectedValueOnce(
          new InvalidMimeTypeError('text/html', ['image/jpeg'])
        );

      const formData = createFileFormData([
        { name: 'ok.jpg', content: 'data', type: 'image/jpeg' },
        { name: 'bad.html', content: 'data', type: 'text/html' },
      ]);
      const request = createRequest(formData);
      const response = await POST(request);

      expect(response.status).toBe(415);
      expect(mockUploadFile).toHaveBeenCalledTimes(2);
    });
  });
});
