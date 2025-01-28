

let runTimeStamp: string | null = null;

if (!runTimeStamp) {
  runTimeStamp = new Date().toISOString();
}

export { runTimeStamp };