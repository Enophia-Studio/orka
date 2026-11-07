// Images in the message box: what can be attached and how large it is sent.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validImages } from '../src/SessionController';
import { fitWithin, imageProblem, MAX_IMAGE_EDGE, MAX_IMAGE_FILE_BYTES, MAX_IMAGES, pickImages } from '../webview/features/images';

const file = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('attaching images', () => {
  it('takes PNG, JPEG, GIF and WebP and refuses other types and very large files, saying why', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) assert.equal(imageProblem(file('a', type)), undefined, type);
    assert.match(imageProblem(file('logo.svg', 'image/svg+xml'))!, /logo\.svg was not attached: only PNG, JPEG, GIF and WebP images can be/);
    assert.match(imageProblem(file('photo.heic', 'image/heic'))!, /photo\.heic was not attached/);
    assert.match(imageProblem(file('big.png', 'image/png', MAX_IMAGE_FILE_BYTES + 1))!, /big\.png was not attached: it is larger than 20 MB/);
    assert.match(imageProblem(file('', 'image/bmp'))!, /^Pasted image was not attached/);
  });

  it('keeps at most five per message and says so once', () => {
    const many = Array.from({ length: 7 }, (_, i) => file(`s${i}.png`, 'image/png'));
    const first = pickImages(many, 0);
    assert.equal(first.accepted.length, MAX_IMAGES);
    assert.deepEqual(first.notices, [`At most ${MAX_IMAGES} images per message.`]);
    const mixed = pickImages([file('a.svg', 'image/svg+xml'), file('b.png', 'image/png'), file('c.png', 'image/png')], 4);
    assert.deepEqual(mixed.accepted.map((f) => f.name), ['b.png']);
    assert.equal(mixed.notices.length, 2);
  });

  it('scales large images down to the long edge, never up', () => {
    assert.deepEqual(fitWithin(4000, 3000, MAX_IMAGE_EDGE), { width: 1568, height: 1176 });
    assert.deepEqual(fitWithin(1000, 3136, MAX_IMAGE_EDGE), { width: 500, height: 1568 });
    assert.deepEqual(fitWithin(800, 600, MAX_IMAGE_EDGE), { width: 800, height: 600 });
    assert.deepEqual(fitWithin(0, 0, 160), { width: 1, height: 1 });
  });

  it('the app checks what the page sends again', () => {
    const ok = { name: 'a.png', mediaType: 'image/png', data: 'iVBORw0KGgo=', thumb: 'data:image/jpeg;base64,AAAA' };
    assert.equal(validImages([ok, { ...ok, mediaType: 'image/svg+xml' }, { ...ok, data: '<script>' }]).length, 1);
    assert.equal(validImages(Array.from({ length: 9 }, () => ok)).length, MAX_IMAGES);
  });
});
