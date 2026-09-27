import { z } from 'zod';

export const BoxIdSchema = z.uuidv4().transform((value) => value.toLowerCase());
export const FlavorSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const NameSchema = z.string().trim().min(1).max(128);
export const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ContentHashSchema = ImageDigestSchema;
// Symbolic lookup key only; never a credential or a filesystem path.
export const SecretReferenceSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/);

// Portable, root-relative file names. Reject encoding rather than decoding twice.
// Filesystem readers MUST additionally check realpath/symlink containment.
export const RelativePathSchema = z.string().min(1).max(1024).refine((value) =>
  value.split('/').every((segment) =>
    /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(segment)),
  'Expected a portable relative path',
);

export const HttpsEndpointSchema = z.string().max(2048).refine((value) => {
  if (!/^https:\/\//.test(value) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 &&
      !url.username && !url.password && !value.includes('?') && !value.includes('#');
  } catch {
    return false;
  }
}, 'Expected HTTPS without credentials, query or fragment');
