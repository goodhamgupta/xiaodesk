import { resetDatabase, db } from './schema.js';
import { seedAll } from '../seed/index.js';

console.log('Resetting database...');
resetDatabase();
console.log('Seeding data...');
seedAll();
console.log('Done!');
db.close();
