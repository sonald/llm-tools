declare module "prismjs/components/prism-core" {
  export type PrismTokenValue = string | PrismToken;

  export type PrismToken = {
    type: string;
    content: PrismTokenValue | PrismTokenValue[];
    alias?: string | string[];
  };

  type PrismLanguage = Record<string, unknown>;

  type PrismInstance = {
    manual: boolean;
    disableWorkerMessageHandler: boolean;
    languages: Record<string, PrismLanguage | undefined>;
    tokenize: (text: string, grammar: PrismLanguage, language?: string) => PrismTokenValue[];
  };

  const Prism: PrismInstance;
  export default Prism;
}

declare module "prismjs/components/*";
