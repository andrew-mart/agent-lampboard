// @ts-check
// Prompts sent through a file: one the agent's terminal took cut short goes whole into a file, and the terminal gets
// only a line telling the agent to read it there.
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * @param {string} dir — ~/.agent-lampboard/prompts
 */
export function createPromptFiles(dir) {
  return {
    /**
     * @param {string} text — the prompt as the page sent it
     * @returns {Promise<string>} — the absolute path of the file it is in
     */
    async save(text) {
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_');
      const path = join(dir, `${stamp}-${randomBytes(4).toString('hex')}.md`);
      await writeFile(path, text, { flag: 'wx' });
      return path;
    },
  };
}

/** Above this count or byte size, image batches go through a prompt file instead of flooding the terminal's input buffer. */
export const maxInlineImagePaths = 10;
export const maxInlineImagePromptBytes = 1024;

/**
 * Whether a prompt carrying attached image paths should automatically be routed through a prompt file so Windows
 * ConPTY 1 KB reads and terminal image-paste replacement never drop or scramble paths.
 * @param {string} whole — prompt text with attached image paths appended
 * @param {number} imageCount
 * @returns {boolean}
 */
export function needsPromptFileForImages(whole, imageCount) {
  return imageCount > 0 && (imageCount > maxInlineImagePaths || Buffer.byteLength(whole) > maxInlineImagePromptBytes);
}

/**
 * The line the agent's terminal gets in place of a prompt put in a file: short enough to come in one read.
 * @param {string} path — where the prompt is
 * @param {number} [imageCount] - how many attached image paths are listed inside the file
 */
export function readPromptLine(path, imageCount = 0) {
  if (imageCount > 0) {
    const noun = imageCount === 1 ? 'image' : 'images';
    return `The prompt (with ${imageCount} attached ${noun}) is in the file ${path}: read it whole, inspect all listed images, and do what it says.`;
  }
  return `The prompt is in the file ${path}: read it whole and do what it says.`;
}
