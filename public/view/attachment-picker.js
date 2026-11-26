// @ts-check
// Images attached in the prompt box: picked from files or the camera, pasted or dropped; shown as thumbnails until sent.
import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * An image waiting in the box to be uploaded and sent.
 * @typedef {{ readonly mediaType: string, readonly blob: Blob, uploaded: string | undefined, partial: import('../model/image-upload.js').PartialUpload | undefined }} AttachedImage
 */

/** A phone photo is scaled down to this long side: enough for Claude to read it, far lighter to send. */
const maxSide = 2048;
/** An image already this small and in a format Claude reads is sent unchanged — a screenshot keeps its sharpness. */
const keepBytes = 1.5 * 1024 * 1024;
const keptTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * @param {{ onChange: () => void, onError: (message: string) => void, onPrepare?: (state: { done: number, total: number } | undefined) => void }} hooks
 */
export function createAttachmentPicker({ onChange, onError, onPrepare }) {
  const input = h('input', { attrs: { type: 'file', accept: 'image/*', multiple: '', hidden: '' } });
  const button = h('button', { className: 'composer-attach', title: 'Attach images', attrs: { type: 'button', 'aria-label': 'Attach images' } }, [icon('attach')]);
  const list = h('div', { className: 'composer-attachments', attrs: { hidden: '' } });
  /** @type {AttachedImage[]} */
  let images = [];
  /** Object URLs created for thumbnail previews, revoked once removed or cleared. @type {Map<AttachedImage, string>} */
  const previews = new Map();
  /** Thumbnail containers by image, so upload state updates without redrawing every thumbnail. @type {Map<AttachedImage, HTMLElement>} */
  const tiles = new Map();
  let locked = false;
  let preparingCount = 0;

  /** @param {AttachedImage} image */
  const revokePreview = (image) => {
    const url = previews.get(image);
    if (url !== undefined && url !== '' && typeof URL.revokeObjectURL === 'function') {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore environments without object URLs
      }
    }
    previews.delete(image);
    tiles.delete(image);
  };

  /** @param {AttachedImage} image */
  const previewOf = (image) => {
    const existing = previews.get(image);
    if (existing !== undefined) return existing;
    let url = '';
    if (typeof URL.createObjectURL === 'function') {
      try {
        url = URL.createObjectURL(image.blob);
      } catch {
        url = '';
      }
    }
    previews.set(image, url);
    return url;
  };

  const render = () => {
    list.hidden = images.length === 0;
    list.classList.toggle('locked', locked);
    tiles.clear();
    list.replaceChildren(
      ...images.map((image) => {
        const preview = h('img', { attrs: { alt: '' } });
        const url = previewOf(image);
        if (url !== '') preview.src = url;
        const remove = h('button', { className: 'attachment-remove', title: 'Remove', attrs: { type: 'button', 'aria-label': 'Remove image' } }, [icon('cross')]);
        remove.disabled = locked;
        remove.addEventListener('click', () => {
          if (locked) return;
          revokePreview(image);
          images = images.filter((other) => other !== image);
          render();
          onChange();
        });
        const tile = h('div', { className: `attachment${image.uploaded === undefined ? '' : ' uploaded'}` }, [preview, remove]);
        tiles.set(image, tile);
        return tile;
      }),
    );
  };

  /** @param {readonly File[]} files */
  const add = async (files) => {
    const eligible = files.filter((candidate) => candidate.type.startsWith('image/'));
    if (eligible.length === 0) return;
    preparingCount++;
    onChange();
    let done = 0;
    try {
      for (const file of eligible) {
        if (eligible.length > 1) onPrepare?.({ done, total: eligible.length });
        const ready = await prepare(file).catch(() => undefined);
        done++;
        if (ready === undefined) onError(`Could not read ${file.name} as an image.`);
        else {
          images = [...images, { mediaType: ready.mediaType, blob: ready.blob, uploaded: undefined, partial: undefined }];
          render();
        }
        if (eligible.length > 1) onPrepare?.({ done, total: eligible.length });
      }
    } finally {
      preparingCount--;
      if (preparingCount === 0) onPrepare?.(undefined);
      render();
      onChange();
    }
  };
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    void add([...(input.files ?? [])]);
    input.value = '';
  });

  return {
    button,
    list,
    input,
    add,
    /** @returns {readonly AttachedImage[]} */
    images: () => images,
    preparing: () => preparingCount > 0,
    /** @param {AttachedImage} image @param {string} name */
    markUploaded(image, name) {
      if (!images.includes(image)) return;
      image.uploaded = name;
      image.partial = undefined;
      tiles.get(image)?.classList.add('uploaded');
    },
    /** @param {AttachedImage} image @param {import('../model/image-upload.js').PartialUpload | undefined} partial */
    setPartial(image, partial) {
      if (!images.includes(image)) return;
      image.partial = partial;
    },
    /** @param {ReadonlySet<string>} names */
    forgetUploaded(names) {
      for (const image of images) {
        if (image.uploaded !== undefined && names.has(image.uploaded)) {
          image.uploaded = undefined;
          image.partial = undefined;
          tiles.get(image)?.classList.remove('uploaded');
        }
      }
    },
    /** @param {boolean} next */
    setLocked(next) {
      locked = next;
      list.classList.toggle('locked', locked);
      for (const button of list.querySelectorAll('.attachment-remove')) {
        if (button instanceof window.HTMLButtonElement) button.disabled = locked;
      }
    },
    clear() {
      for (const image of images) revokePreview(image);
      images = [];
      render();
    },
    dispose() {
      for (const image of images) revokePreview(image);
      images = [];
    },
  };
}

/**
 * A photo from a phone weighs megabytes: it is scaled down and re-encoded as JPEG; a small image in a format Claude
 * reads goes as it is.
 * @param {File} file
 * @returns {Promise<{ mediaType: string, blob: Blob }>}
 */
async function prepare(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= keepBytes && keptTypes.has(file.type)) {
    bitmap.close();
    return { mediaType: file.type, blob: file };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The browser gave no 2D canvas to scale the image on');
  // JPEG has no transparency: transparent parts of a PNG become white, not black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  /** @type {Blob} */
  const jpeg = await new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob === null ? reject(new Error('The image could not be encoded as JPEG')) : resolve(blob)), 'image/jpeg', 0.85),
  );
  return { mediaType: 'image/jpeg', blob: jpeg };
}
