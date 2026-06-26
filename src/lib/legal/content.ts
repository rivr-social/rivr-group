/**
 * Canonical legal content for RIVR's Terms of Service and Privacy Policy.
 *
 * IMPORTANT — DRAFT FOR LEGAL REVIEW:
 * This is an industry-standard starting draft tailored to RIVR's federated
 * architecture. It is intended to be reviewed and finalized by qualified legal
 * counsel before it is relied upon. Items requiring business/legal input are
 * marked with bracketed placeholders (e.g. `[LEGAL ENTITY]`) and surfaced in
 * the constants below so they are easy to find and replace.
 *
 * The same content module is shared by:
 * - `/terms` (public Terms of Service page)
 * - `/privacy` (public Privacy Policy page)
 * - the in-flow signup review step (`/auth/signup/terms`)
 *
 * @module lib/legal/content
 */

/** Service / brand name shown to users. */
export const LEGAL_SERVICE_NAME = "RIVR";

/**
 * Formal legal entity that operates the hosted service. Replace with the
 * registered company name (e.g. "RIVR, Inc." / "RIVR Cooperative") once
 * confirmed with counsel.
 */
export const LEGAL_ENTITY = "RIVR (the operator of the RIVR platform)";

/**
 * Governing-law jurisdiction. Defaulted to Colorado given the project's
 * footprint; CONFIRM with counsel before relying on it.
 */
export const LEGAL_GOVERNING_LAW = "the State of Colorado, United States";

/** Minimum age of eligibility. GDPR digital-consent age is 16 in many EU states. */
export const LEGAL_MINIMUM_AGE = "16";

/** Contact addresses for legal and privacy inquiries. */
export const LEGAL_CONTACT_EMAIL = "legal@rivr.social";
export const PRIVACY_CONTACT_EMAIL = "privacy@rivr.social";

/** Effective / last-updated date for both documents (ISO and display forms). */
export const LEGAL_EFFECTIVE_DATE = "2026-06-26";
export const LEGAL_EFFECTIVE_DATE_DISPLAY = "June 26, 2026";

/** A single content section within a legal document. */
export interface LegalSection {
  /** Section heading, rendered as a sub-heading and used as an anchor id source. */
  heading: string;
  /** Ordered paragraphs of body text. */
  body?: string[];
  /** Optional bullet list rendered after the body paragraphs. */
  bullets?: string[];
}

/** A complete legal document: title, dates, intro, and ordered sections. */
export interface LegalDocumentContent {
  title: string;
  effectiveDate: string;
  intro: string[];
  sections: LegalSection[];
}

/**
 * Terms of Service.
 */
export const TERMS_OF_SERVICE: LegalDocumentContent = {
  title: "Terms of Service",
  effectiveDate: LEGAL_EFFECTIVE_DATE_DISPLAY,
  intro: [
    `These Terms of Service ("Terms") are a binding agreement between you and ${LEGAL_ENTITY} ("${LEGAL_SERVICE_NAME}", "we", "us", or "our") and govern your access to and use of the ${LEGAL_SERVICE_NAME} websites, applications, APIs, and related services (collectively, the "Service").`,
    `Please read these Terms carefully. By creating an account, accessing, or using the Service, you agree to be bound by these Terms and by our Privacy Policy, which is incorporated by reference. If you do not agree, do not use the Service.`,
  ],
  sections: [
    {
      heading: "1. Eligibility",
      body: [
        `You must be at least ${LEGAL_MINIMUM_AGE} years old, or the age of digital consent in your jurisdiction if higher, to create an account or use the Service. If you use the Service on behalf of an organization, you represent that you are authorized to bind that organization to these Terms.`,
        `You may not use the Service if you are barred from doing so under applicable law or have previously been suspended or removed from the Service.`,
      ],
    },
    {
      heading: "2. The Service and Federation",
      body: [
        `${LEGAL_SERVICE_NAME} is a federated social and civic coordination platform. The hosted ${LEGAL_SERVICE_NAME} application interoperates with independently operated "sovereign" instances (for example, instances run by people, groups, locales, or regions) using a federation protocol.`,
        `Because the Service is federated, content and certain account information you choose to make public or share may be transmitted to, stored on, and displayed by other instances and networks you interact with. Independent instances are operated by third parties under their own terms and policies, and we do not control them. Your interactions with sovereign instances may be governed by additional terms presented by those instances.`,
      ],
    },
    {
      heading: "3. Your Account",
      body: [
        `You are responsible for the information you provide and for maintaining the confidentiality and security of your account credentials. You agree to provide accurate, current, and complete information and to keep it up to date.`,
        `You are responsible for all activity that occurs under your account. Notify us promptly of any unauthorized use or suspected security breach. We are not liable for any loss arising from unauthorized use of your account.`,
      ],
    },
    {
      heading: "4. Your Content and License",
      body: [
        `You retain ownership of the content you create, post, or share through the Service ("Your Content"). You are solely responsible for Your Content and the consequences of sharing it.`,
        `You grant ${LEGAL_SERVICE_NAME} a worldwide, non-exclusive, royalty-free license to host, store, reproduce, modify (for technical purposes such as formatting), publish, transmit, and display Your Content solely as necessary to operate, provide, secure, and improve the Service — including transmitting Your Content to other instances and networks where you have chosen to share or federate it. This license ends when Your Content is deleted, except to the extent it has already been federated to or shared with other parties, retained in backups for a limited period, or where retention is required by law.`,
        `You represent and warrant that you have the rights necessary to grant this license and that Your Content does not violate the rights of any third party or any applicable law.`,
      ],
    },
    {
      heading: "5. Acceptable Use",
      body: [
        `You agree not to misuse the Service. Without limitation, you agree not to:`,
      ],
      bullets: [
        "Violate any applicable law or the rights of others, including intellectual property, privacy, and publicity rights;",
        "Post or transmit content that is unlawful, harassing, abusive, defamatory, hateful, or that incites violence or harm;",
        "Upload malware, or attempt to gain unauthorized access to the Service, other accounts, or connected systems;",
        "Interfere with or disrupt the integrity or performance of the Service, including its federation and messaging infrastructure;",
        "Engage in spam, fraud, impersonation, or deceptive practices;",
        "Scrape, harvest, or collect data about users except as expressly permitted by the Service or applicable law;",
        "Use the Service to develop a competing service by misappropriating our confidential information.",
      ],
    },
    {
      heading: "6. Community Spaces and Moderation",
      body: [
        `Groups, locales, regions, and other community spaces may set their own rules and may be moderated by their administrators. We may, but are not obligated to, review content and may remove content or limit, suspend, or terminate access that we reasonably believe violates these Terms or applicable law, or that may harm users, third parties, or the Service.`,
      ],
    },
    {
      heading: "7. Marketplace, Payments, and Fees",
      body: [
        `The Service may allow you to offer, purchase, or contribute to listings, events, projects, subscriptions, or grant rounds. Payment processing is provided by third-party processors (for example, Stripe) and is subject to their terms and privacy policies. You authorize the applicable processor to charge your payment method for amounts you approve.`,
        `Transactions in the marketplace are between the participating users or organizations. Unless expressly stated, ${LEGAL_SERVICE_NAME} is not a party to those transactions and is not responsible for the goods, services, or commitments offered. Applicable platform, processing, or service fees will be disclosed before you complete a transaction. Except as required by law, fees are non-refundable.`,
      ],
    },
    {
      heading: "8. Intellectual Property",
      body: [
        `The Service, including its software, design, and trademarks, is owned by ${LEGAL_SERVICE_NAME} or its licensors and is protected by intellectual property laws. Except for the rights expressly granted to you, no rights are transferred to you. You may not copy, modify, distribute, sell, or lease any part of the Service except as permitted by these Terms, applicable open-source licenses, or with our prior written consent.`,
        `If you provide feedback or suggestions, you grant us a non-exclusive, perpetual, irrevocable, royalty-free license to use them without restriction or obligation to you.`,
      ],
    },
    {
      heading: "9. Third-Party Services",
      body: [
        `The Service may integrate with or link to third-party services (for example, payment processors, messaging, storage, calendar, or identity providers). Your use of those services is governed by their terms and privacy policies, and we are not responsible for them.`,
      ],
    },
    {
      heading: "10. Disclaimers",
      body: [
        `THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, SECURE, OR ERROR-FREE, OR THAT CONTENT FEDERATED TO OR FROM OTHER INSTANCES WILL BE ACCURATE OR AVAILABLE.`,
      ],
    },
    {
      heading: "11. Limitation of Liability",
      body: [
        `TO THE MAXIMUM EXTENT PERMITTED BY LAW, ${LEGAL_SERVICE_NAME.toUpperCase()} AND ITS AFFILIATES, OFFICERS, EMPLOYEES, AND AGENTS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, DATA, GOODWILL, OR OTHER INTANGIBLE LOSSES, ARISING OUT OF OR RELATED TO YOUR USE OF THE SERVICE.`,
        `TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY FOR ANY CLAIM ARISING OUT OF OR RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF THE AMOUNTS YOU PAID US IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR ONE HUNDRED U.S. DOLLARS ($100). Some jurisdictions do not allow certain limitations, so some of the above may not apply to you.`,
      ],
    },
    {
      heading: "12. Indemnification",
      body: [
        `You agree to defend, indemnify, and hold harmless ${LEGAL_SERVICE_NAME} and its affiliates from and against any claims, liabilities, damages, losses, and expenses (including reasonable legal fees) arising out of or related to your use of the Service, Your Content, or your violation of these Terms or applicable law.`,
      ],
    },
    {
      heading: "13. Suspension and Termination",
      body: [
        `You may stop using the Service and delete your account at any time. We may suspend or terminate your access if you violate these Terms, if required by law, or to protect users, third parties, or the Service. Provisions that by their nature should survive termination (including ownership, disclaimers, limitation of liability, and indemnification) will survive.`,
      ],
    },
    {
      heading: "14. Governing Law and Disputes",
      body: [
        `These Terms are governed by the laws of ${LEGAL_GOVERNING_LAW}, without regard to conflict-of-laws principles. Before filing a claim, you agree to try to resolve the dispute informally by contacting us. The courts located in that jurisdiction will have exclusive jurisdiction over disputes, except where applicable law provides otherwise.`,
      ],
    },
    {
      heading: "15. Changes to These Terms",
      body: [
        `We may update these Terms from time to time. If we make material changes, we will provide reasonable notice (for example, by posting the updated Terms with a new effective date or notifying you in the Service). Your continued use of the Service after the changes take effect constitutes acceptance of the updated Terms.`,
      ],
    },
    {
      heading: "16. General",
      body: [
        `If any provision of these Terms is held unenforceable, the remaining provisions will remain in effect. Our failure to enforce a provision is not a waiver. You may not assign these Terms without our consent; we may assign them in connection with a merger, acquisition, or sale of assets. These Terms, together with the Privacy Policy, constitute the entire agreement between you and us regarding the Service.`,
      ],
    },
    {
      heading: "17. Contact",
      body: [
        `Questions about these Terms can be sent to ${LEGAL_CONTACT_EMAIL}.`,
      ],
    },
  ],
};

/**
 * Privacy Policy.
 */
export const PRIVACY_POLICY: LegalDocumentContent = {
  title: "Privacy Policy",
  effectiveDate: LEGAL_EFFECTIVE_DATE_DISPLAY,
  intro: [
    `This Privacy Policy explains how ${LEGAL_ENTITY} ("${LEGAL_SERVICE_NAME}", "we", "us", or "our") collects, uses, shares, and protects information in connection with the ${LEGAL_SERVICE_NAME} websites, applications, APIs, and related services (the "Service").`,
    `Because ${LEGAL_SERVICE_NAME} is a federated platform, this Policy describes how information may move between the hosted Service and independently operated instances. By using the Service, you agree to this Policy.`,
  ],
  sections: [
    {
      heading: "1. Information We Collect",
      body: [
        `We collect information you provide, information generated through your use of the Service, and information from third parties.`,
      ],
      bullets: [
        "Account information: name, email address, password (stored only as a salted hash), and profile details you choose to add;",
        "Content: posts, messages, events, listings, profiles, and other content you create or share, including media you upload;",
        "Transaction information: records of marketplace activity and contributions. Payment card details are handled by our payment processor and are not stored by us;",
        "Usage and device data: log data such as IP address, browser/device type, pages or features used, and timestamps, used for security, diagnostics, and improving the Service;",
        "Cookies and similar technologies: used for authentication, preferences, and basic analytics (see the Cookies section);",
        "Communications: messages you send us for support and related metadata.",
      ],
    },
    {
      heading: "2. How We Use Information",
      body: [`We use information to:`],
      bullets: [
        "Provide, operate, secure, and improve the Service;",
        "Create and manage your account, and authenticate you (including cross-instance single sign-on where applicable);",
        "Enable social, civic, marketplace, and messaging features you choose to use;",
        "Send transactional and, where you have opted in, notification or update emails;",
        "Detect, prevent, and respond to fraud, abuse, security incidents, and violations of our Terms;",
        "Comply with legal obligations and enforce our agreements.",
      ],
    },
    {
      heading: "3. Federation and Cross-Instance Sharing",
      body: [
        `${LEGAL_SERVICE_NAME} federates with independently operated instances. When you make content public or choose to share or interact with another instance, the relevant content and certain account identifiers (such as your public profile and the cryptographic identifiers used to verify your activity) may be transmitted to and stored by those instances and the broader federation network.`,
        `Information that has been federated to or shared with another instance may continue to exist on that instance even after you delete it from the hosted Service, because independent instances control their own copies. We act as a credential authority for parts of the network; in that role we verify sign-in requests on behalf of participating instances.`,
      ],
    },
    {
      heading: "4. How We Share Information",
      body: [`We share information only as described in this Policy, including:`],
      bullets: [
        "With other users and instances, according to your sharing, visibility, and federation choices;",
        "With service providers who process information on our behalf under contract (see Service Providers below);",
        "For legal reasons, such as to comply with law, respond to lawful requests, or protect the rights, safety, and security of users, the public, or the Service;",
        "In a business transfer, such as a merger, acquisition, or sale of assets, subject to this Policy;",
        "With your consent or at your direction.",
      ],
    },
    {
      heading: "5. Service Providers",
      body: [
        `We rely on third-party providers to operate the Service, including payment processing (for example, Stripe), messaging infrastructure (for example, Matrix/Synapse), object storage (for example, an S3-compatible store), email delivery, and hosting. These providers process information only as needed to provide their services to us. If you opt in, your eligible public profile may also be published to the Murmurations network; this is optional and off by default.`,
      ],
    },
    {
      heading: "6. Cookies and Similar Technologies",
      body: [
        `We use cookies and similar technologies to keep you signed in, remember preferences, and understand basic usage. You can control cookies through your browser settings; disabling some cookies may affect functionality such as staying logged in.`,
      ],
    },
    {
      heading: "7. Data Retention",
      body: [
        `We retain information for as long as your account is active or as needed to provide the Service, comply with legal obligations, resolve disputes, and enforce our agreements. We may retain limited information in backups for a reasonable period and de-identified or aggregated information that no longer identifies you.`,
      ],
    },
    {
      heading: "8. Your Rights and Choices",
      body: [
        `Depending on your jurisdiction, you may have rights to access, correct, delete, or port your information, to object to or restrict certain processing, and to withdraw consent. You can update much of your information in your account settings, manage notification preferences, and request account deletion. To exercise other rights, contact us at ${PRIVACY_CONTACT_EMAIL}. We will not discriminate against you for exercising these rights. Note that federation may limit our ability to delete copies held by independent instances.`,
      ],
    },
    {
      heading: "9. Data Security",
      body: [
        `We use technical and organizational measures designed to protect information, including encryption in transit, hashing of passwords, and access controls. No method of transmission or storage is completely secure, and we cannot guarantee absolute security.`,
      ],
    },
    {
      heading: "10. International Transfers",
      body: [
        `The Service may be operated from, and information may be processed in, countries other than where you live. Where required, we use appropriate safeguards for international transfers. By using the Service, you understand your information may be transferred to and processed in those locations.`,
      ],
    },
    {
      heading: "11. Children's Privacy",
      body: [
        `The Service is not directed to children under the minimum age described in our Terms, and we do not knowingly collect personal information from them. If you believe a child has provided us information, contact us and we will take appropriate steps to delete it.`,
      ],
    },
    {
      heading: "12. Third-Party Links and Instances",
      body: [
        `The Service may contain links to, or interoperate with, third-party websites and independently operated instances that we do not control. Their privacy practices are governed by their own policies, and we encourage you to review them.`,
      ],
    },
    {
      heading: "13. Changes to This Policy",
      body: [
        `We may update this Policy from time to time. If we make material changes, we will provide reasonable notice, such as posting the updated Policy with a new effective date. Your continued use of the Service after the changes take effect constitutes acceptance of the updated Policy.`,
      ],
    },
    {
      heading: "14. Contact",
      body: [
        `For privacy questions or to exercise your rights, contact us at ${PRIVACY_CONTACT_EMAIL}.`,
      ],
    },
  ],
};
