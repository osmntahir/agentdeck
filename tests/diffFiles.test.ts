import test from 'node:test'
import assert from 'node:assert/strict'
import { diffFiles } from '../src/shared/diffFiles'

test('dosyalar ayrı açılır; hunk satırları ve ekleme/silme sayıları doğrudur', () => {
  const files = diffFiles('diff --git a/first.ts b/first.ts\n--- a/first.ts\n+++ b/first.ts\n@@ -3,2 +3,2 @@\n keep\n-old\n+new\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n')
  assert.equal(files.length, 2)
  assert.equal(files[0].path, 'first.ts')
  assert.equal(files[0].added, 1)
  assert.equal(files[0].removed, 1)
  assert.deepEqual(files[0].lines.find(line => line.kind === 'add'), { text: '+new', kind: 'add', old: null, next: 4 })
  assert.equal(files[1].lines.at(-1)?.next, 1)
  assert.equal(files[0].change, 'modified')
  assert.equal(files[1].change, 'added')
})

test('silinen, rename, ikili ve C-quoted Unicode dosyaları korunur', () => {
  const files = diffFiles('diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\ndiff --git "a/\\303\\274.txt" "b/\\303\\274.txt"\n--- "a/\\303\\274.txt"\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n')
  assert.equal(files[0].path, 'new name')
  assert.equal(files[0].change, 'renamed')
  assert.equal(files[1].binary, true)
  assert.equal(files[2].path, 'ü.txt')
  assert.equal(files[2].removed, 1)
  assert.equal(files[2].change, 'deleted')
})

test('içerikteki patch başlıkları dosya kimliğini değiştirmez', () => {
  const [file] = diffFiles('diff --git a/real b/real\n--- a/real\n+++ b/real\n@@ -1 +1 @@\n--- a/fake\n+++ b/fake\n')
  assert.equal(file.path, 'real')
  assert.equal(file.added, 1)
  assert.equal(file.removed, 1)
})
