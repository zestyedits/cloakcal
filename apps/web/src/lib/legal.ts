/**
 * The privacy policy and the terms, as DATA rather than JSX.
 *
 * Two reasons it is not markup. `/settings` and the landing footer both link into sections of
 * it, and a fallback or a table of contents that needs the section list would otherwise import
 * a value out of a `'use client'` module — which returns a client-reference proxy, not the
 * value, and renders as a doubled page rather than an error. That is the exact bug
 * `lib/settings-sections.ts` and `lib/calendar-views.ts` exist to prevent, and it cost a whole
 * settings page once. The second reason is that a test can read prose as strings and check the
 * claims against the schema; it cannot do that to a tree of elements.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS THE WORST PAGE IN THE PRODUCT TO OVERCLAIM ON. Read rule 1 in CLAUDE.md before
 * touching a sentence here.
 *
 * CloakCal is NOT zero-knowledge and must never be described as such. The server stores when
 * events happen, how long they last, how they repeat, which calendar they belong to, and the
 * shape of your contacts and groups — all in the clear, because booking, reminders and
 * conflict detection need them. It stores CONTENT — titles, locations, notes, attendees, and
 * the names of calendars, contacts and groups — as ciphertext only.
 *
 * The claim is "other people cannot read your content", never "we cannot see anything". The
 * phrase "zero knowledge" appears in exactly one place below: a sentence denying it.
 *
 * `legal.server.test.ts` checks this document against the actual migrations, so a new
 * plaintext column that nobody disclosed here turns the suite red rather than quietly making
 * this page false.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * NOT LEGAL ADVICE AND NOT WRITTEN BY A LAWYER. Drafted to be accurate about the system and
 * readable by a human. It needs review by someone qualified before sign-ups open.
 */

/**
 * The address is imported rather than declared here, and that is not tidying.
 *
 * `legal-claims.server.test.ts` excludes this module from its source sweep by name, so that a
 * claim in this file can never be the evidence that the same claim is backed. Anything the
 * app genuinely ACTS on therefore has to live outside it, or the guard goes blind the moment
 * a capability is defined in the document that describes it. `lib/contact.ts` is where the
 * address, the route and the reasoning about forms live.
 */
import { SUPPORT_EMAIL } from './contact'

export interface LegalSection {
  readonly id: string
  readonly heading: string
  /** Plain paragraphs. Rendered in order, one <p> each. */
  readonly body: readonly string[]
  /** Optional bullets, rendered after the body. */
  readonly list?: readonly string[]
}

export interface LegalDocument {
  readonly slug: 'privacy' | 'terms'
  readonly title: string
  readonly lede: string
  /** Shown so a reader can tell whether they are looking at a current document. */
  readonly updated: string
  readonly sections: readonly LegalSection[]
}

/**
 * Changing this without changing the documents is worse than leaving it stale, and the
 * converse is what moved it here: this pass added a THIRD PARTY (Zoho, which receives anything
 * you email us) and a section describing what we get when you write. The "Changes to this
 * policy" section below promises to say so and date the change, so a documents edit that left
 * the date alone would falsify the one clause whose whole subject is edits.
 *
 * The same clause promises an email for a material change rather than a silent one. Nothing is
 * owed here: sign-ups are closed, so there is nobody to tell. The day that stops being true,
 * this constant moving is the reminder that the obligation attached.
 */
const UPDATED = '19 August 2026'

/**
 * Every plaintext fact the server holds, named.
 *
 * Kept as its own exported list because the test drives off it: each entry has to correspond
 * to something that genuinely exists in the schema, and every readable column in the schema
 * has to be covered by an entry. Prose alone drifts; a list can be checked.
 */
export const READABLE_TO_US: readonly string[] = [
  'Your email address, and when you signed in.',
  'When your events happen: start time, end time, and how they repeat.',
  'Which of your calendars an event belongs to, and that calendar\'s colour.',
  'Which occurrences of a repeating event you moved or cancelled.',
  'Your visibility rules: which contact or group you granted what level of detail to.',
  'The structure of your address book: how many contacts and groups you have, and who belongs to which group.',
  'Your display settings: timezone, the day your week starts, the view you open on, and which country\'s holidays you show.',
  'Your weekly availability, if you set it.',
  'Which devices and passkeys can open your account, and when each was last used.',
  'Your billing tier, and if you ever subscribe, the customer id our payment processor gives us.',
]

/** Everything the server only ever holds as ciphertext. */
export const NEVER_READABLE_TO_US: readonly string[] = [
  'Event titles.',
  'Locations.',
  'Notes and descriptions.',
  'Who is attending.',
  'The names you give your calendars.',
  'The names of your contacts and the labels on your groups.',
]

export const PRIVACY: LegalDocument = {
  slug: 'privacy',
  title: 'Privacy',
  lede:
    'What CloakCal stores, what it cannot read, and what you can do about it. Written to be exact rather than reassuring.',
  updated: UPDATED,
  sections: [
    {
      id: 'the-short-version',
      heading: 'The short version',
      body: [
        'The content of your events is encrypted in your browser, with keys derived from your password, before it is sent to us. We store the result and cannot read it. Nobody at CloakCal can, and neither can anyone who breaks into our servers or arrives with a court order.',
        'We can see when your events happen. Times, durations, how often something repeats, and which calendar it belongs to are stored in the clear, because a calendar cannot place, repeat or lay out an event without them. Features that would also need them, like reminders and booking, are planned rather than built.',
        'So the promise is exact: other people cannot read your content. It is not that we cannot see anything. CloakCal is not zero-knowledge and we will not describe it that way, because a privacy product that overclaims is a privacy product that lies.',
      ],
    },
    {
      id: 'readable',
      heading: 'What we can read',
      body: [
        'All of this is stored in ordinary, readable form on our servers. We hold it because the product does not function without it.',
      ],
      list: READABLE_TO_US,
    },
    {
      id: 'encrypted',
      heading: 'What we cannot read',
      body: [
        'All of this is encrypted in your browser before it reaches us, and we only ever hold the encrypted version.',
      ],
      list: NEVER_READABLE_TO_US,
    },
    {
      /*
       * TONE ONLY. Every fact in this section is unchanged and none may be dropped: times are
       * plaintext (plan D1), and ciphertext is unpadded today (CLAUDE.md's crypto-agility
       * note lists length-bucket padding as future work, and `packages/crypto/src/cloak.ts`
       * has no padding in the seal path). Rewritten to open on what IS protected rather than
       * on the limit, because the previous order read as a warning label on a product the
       * reader had not yet decided to trust.
       */
      id: 'metadata',
      heading: 'What we protect, and what we cannot',
      body: [
        'Your content is genuinely safe. Nobody with access to our database can read a title, a location, a note or a guest list. That holds against us, against anyone who copies the whole database, and against anyone who compels us to hand it over.',
        'The shape of your week is a different matter. Because times stay readable, someone with that access could tell that you keep an hour free every Tuesday morning, that a Friday evening was busy, or that a fortnight was quiet. They would not know what any of it was for, only that something was there.',
        'One more, while we are being exact: encrypted content is stored at its true length, so a long note is visibly longer than a short one. Padding it to fixed sizes is on our list and is not done yet.',
        'For almost everyone this is a good trade, and it is the trade that lets reminders, conflict checks and booking work at all. But if the pattern itself is the sensitive part, and when you met someone matters as much as who you met, then CloakCal is not the right tool for that, and we would rather you knew now than later.',
      ],
    },
    {
      id: 'keys',
      heading: 'Your password and your keys',
      body: [
        'Your password never leaves your browser. It is used to derive the key that unlocks your content, and we store only a wrapped version that cannot be opened without it.',
        'Your email address is part of that derivation, which is why there is currently no way to change it: a new address would produce a different key and your existing content would not open.',
        'If you lose both your password and your 24 word recovery phrase, and you have no passkey registered, your content is gone. We cannot reset it, recover it or reconstruct it. That is the direct consequence of not being able to read it, and it is the trade this product makes.',
      ],
    },
    {
      id: 'third-parties',
      heading: 'Who else is involved',
      body: [
        'We keep this list short on purpose, and every entry is infrastructure rather than a partner we share anything with for our own benefit.',
      ],
      list: [
        'Supabase hosts our database and handles sign-in. They hold the same data we do, in the same form, including the encrypted content they cannot read.',
        'Vercel hosts and serves the site.',
        'Resend sends transactional email: confirmations, password resets, and nothing else.',
        'Zoho hosts the mailbox behind our contact address. If you write to us, Zoho receives and stores that message, in the same way your own provider does at your end. It holds nothing else about you, and nothing from your calendar ever passes through it.',
        'Stripe processes payments for the Pro plan. If you subscribe, Stripe receives your card details and the email address you give them at checkout, which does not have to be the one you sign in with. We receive an identifier for you at Stripe, whether the subscription is active, and when it renews. Your card number never reaches us.',
      ],
    },
    {
      id: 'tracking',
      heading: 'Tracking, advertising and analytics',
      body: [
        'There is none. No analytics product, no advertising network, no third party scripts, and no cookies beyond the one that keeps you signed in and the one that remembers your display settings.',
        'Our emails contain no tracking pixels. An image in an email is a read receipt you did not agree to, and we do not send one even though nobody would notice.',
        'We do not sell, rent or share your data, in any form, encrypted or otherwise.',
      ],
    },
    {
      /*
       * THE SECTION THAT HAD TO ARRIVE WITH THE CONTACT PAGE, NOT AFTER IT.
       *
       * Making the address findable to a signed-out visitor is the point of that page, and the
       * moment a route in is advertised, what happens to what arrives through it is a
       * disclosure obligation rather than an implementation detail. Everything here is a fact
       * about ordinary email, which is exactly why it is worth stating: a reader who chose
       * this product specifically because its content is sealed will reasonably assume writing
       * to us is sealed too, and it is not.
       *
       * The first paragraph also records WHY there is no form, because "why is there no
       * contact form on a modern product" is a question a cautious reader asks, and the answer
       * is a privacy answer rather than an unfinished one. The engineering half of the same
       * reasoning is in `lib/contact.ts`.
       */
      id: 'writing-to-us',
      heading: 'If you write to us',
      body: [
        'There is no contact form on this site, and that is a decision rather than a gap. A form would put whatever you typed onto our servers before a person ever read it, which is one more copy of your words sitting in the clear somewhere you did not choose. So there is an address instead, on our contact page, and your message travels the way any other email does.',
        'What we receive is your email address and whatever you decide to write, in ordinary readable form. Email is not protected the way your event content is: your mail provider can read it, our mail provider can read it, and so can we. Please do not paste something into a message to us that you picked CloakCal specifically to keep out of one, and never send us your password or your recovery phrase. There is nothing we could do with either except be somewhere they leaked from.',
        'We keep a message for as long as it takes to answer you, plus whatever record we need of anything we did to your account on the strength of it, and we delete it after that. Nothing enforces that on a timer, and we would rather say so than imply a machine is doing it: it is a person deleting a thread. If you want yours gone sooner, ask in it.',
      ],
    },
    {
      id: 'your-rights',
      heading: 'What you can do',
      body: [
        'You can export your calendar as a standard .ics file from Settings, under Security and data. It is assembled in your browser from your own decrypted content, so the file holds things our servers have never seen, and it never goes back to us. Repeating events keep their rule rather than being flattened into copies. Export is free permanently: charging to leave is not something a privacy product gets to do.',
        'You can have your account deleted by emailing us, from the address you sign in with. That erases every event, calendar, contact, rule and setting we hold for you, and it cannot be undone. There is no button for this yet, and we would rather say so than point you at one that is not there. The address is on our contact page, along with why we ask you to write from that particular one.',
        'If you are in the UK, EU or California, you have statutory rights to access, correct, export and erase your personal data. Where there is a control above, that is how we meet them. Where there is not one yet, email us and we will do it by hand, which is how deletion works today. For anything else, the address is on our contact page.',
      ],
    },
    {
      id: 'retention',
      heading: 'How long we keep things',
      body: [
        'Your data stays until you delete it or delete your account. There is no archive, no soft-delete tier we keep for ourselves, and no backup we would restore your content from after you asked us to erase it.',
        'Deleting an event moves it to Trash, in Settings under Security and data, where it stays until you put it back or remove it permanently. Nothing expires it on a timer, and we would rather tell you that than call it something that implies one. Its content is still encrypted the whole time it sits there, exactly as it was before you deleted it.',
        'Removing an event permanently erases its encrypted content: the title, location, notes and attendees. Neither you nor we can recover it afterwards. One thing survives, and we would rather name it here than let you discover it later. A record that an event existed and was deleted stays in your account log, holding no content of any kind. No signed-in account can alter or remove that log, including yours, because the database refuses those operations to every account. We operate the database, so we are not claiming we could not. We are saying the log holds nothing about you worth altering.',
        'Backups exist for disaster recovery and roll off on their own schedule. Deleted content may persist in a backup briefly before ageing out.',
      ],
    },
    {
      id: 'changes',
      heading: 'Changes to this policy',
      body: [
        'If we change what we store or who we send it to, we will say so here and date the change. A material change gets an email rather than a silent edit.',
      ],
    },
  ],
}

export const TERMS: LegalDocument = {
  slug: 'terms',
  title: 'Terms',
  lede:
    'The agreement between you and CloakCal. Short, and written to be read rather than clicked past.',
  updated: UPDATED,
  sections: [
    {
      id: 'what-this-is',
      heading: 'What CloakCal is',
      body: [
        'A calendar that encrypts your event content in your browser, and lets you show different people different amounts of the same event.',
        'By creating an account you agree to these terms. If you do not, do not create one.',
      ],
    },
    {
      id: 'the-important-one',
      heading: 'The one that is genuinely unusual',
      body: [
        'We cannot recover your content. Not as a policy, as a fact: your password and recovery phrase never reach us in a form we can use, so there is no support process, no escalation and no exception that gets your events back.',
        'If you lose your password and your recovery phrase, and you have not registered a passkey, everything you have written is permanently unreadable. Write the phrase down. Keep it somewhere you would keep a passport.',
        'Most services can reset this for you. We deliberately built one that cannot, because a company that can reset your key is a company that can read your calendar.',
      ],
    },
    {
      id: 'your-account',
      heading: 'Your account',
      body: [
        'You are responsible for what you put in your calendar and for keeping your password and recovery phrase safe.',
        'One account is for one person. Do not use CloakCal for anything unlawful, and do not attack, overload or attempt to break into the service or other people\'s accounts.',
        'You must be old enough to enter a contract where you live.',
      ],
    },
    {
      id: 'availability',
      heading: 'Availability, and what we promise',
      body: [
        'CloakCal is provided as it is. We do not promise it will be uninterrupted or error free, and we do not currently offer a service level agreement.',
        'We may change or discontinue features. If we discontinue something you depend on, or shut down entirely, we will give you notice and time to export.',
        'To the extent the law allows, we are not liable for indirect or consequential loss, and our total liability is limited to what you have paid us in the previous twelve months. If you are on the free plan, that is nothing, and we would rather be plain about it than bury it.',
      ],
    },
    {
      id: 'payment',
      heading: 'Paying',
      body: [
        'Everything CloakCal does today is on the free plan, and cloaking an event stays there permanently. Pro is a paid plan for the work that happens around your calendar.',
        'Where Pro can be bought, the price is shown on the plan page before anything happens, and that is the only amount we charge. If billing is running in test mode, the page says so and no real card is taken.',
        'Stripe takes the payment and holds the card. Your card number never reaches us.',
        'You can cancel from Settings, on the plan page, without contacting us and without going to Stripe. Cancelling stops the next payment and leaves you on Pro until the period you have already paid for runs out. It never deletes your calendar. You can switch between monthly and yearly on the same page, and we show you what the change costs before you confirm.',
        'If you were charged for something you did not mean to buy, email us and we will refund it.',
        'Export stays on the free plan permanently.',
      ],
    },
    {
      id: 'ending',
      heading: 'Ending it',
      body: [
        'You can have your account deleted at any time by emailing us, from the address you sign in with. It takes your data with it and cannot be undone. There is no self-serve button for this yet, and our contact page says why as well as where to write.',
        'We may suspend or close an account that is being used to break the law or to attack the service. We will tell you why unless we are legally prevented from doing so.',
      ],
    },
    {
      id: 'contact',
      heading: 'Contact',
      body: [
        `Questions about these terms, the privacy policy, or your data: write to ${SUPPORT_EMAIL}. Our contact page has the same address, plus the two things it cannot do for you.`,
      ],
    },
  ],
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [PRIVACY, TERMS]
