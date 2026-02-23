declare module 'bcryptjs' {
  const bcrypt: {
    genSalt(rounds?: number): Promise<string>;
    hash(data: string, salt: string): Promise<string>;
    compare(data: string, encrypted: string): Promise<boolean>;
  };

  export default bcrypt;
}
