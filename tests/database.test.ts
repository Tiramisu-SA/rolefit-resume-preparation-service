import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactMongoUri } from '../src/config/database';

test('redactMongoUri hides the user and password', () => {
  assert.equal(
    redactMongoUri('mongodb+srv://user:p%40ss@cluster0.example.net/rolefit_resume_preparation?retryWrites=true'),
    'mongodb+srv://***@cluster0.example.net/rolefit_resume_preparation?retryWrites=true',
  );
  assert.equal(redactMongoUri('mongodb://localhost:27017/db'), 'mongodb://localhost:27017/db');
});
