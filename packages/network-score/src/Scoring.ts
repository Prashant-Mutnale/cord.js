/**
 * @packageDocumentation
 * @module NetworkScore
 *
 * Network Scoring System Module.
 *
 * Overview:
 * This module offers a comprehensive suite of functionalities to interact with a blockchain-based rating system.
 * It is part of the Cord Network ecosystem and is designed to facilitate various operations related to ratings,
 * such as creation, revocation, and revision of rating entries, as well as fetching and aggregating rating data
 * from the blockchain. The module integrates with the Cord Network's blockchain API and types, providing an interface
 * for rating-related transactions and data handling on the blockchain.
 *
 * Key Functionalities:
 * - Creating and dispatching new rating entries to the blockchain.
 * - Revoking existing ratings, allowing for the removal of obsolete or incorrect ratings.
 * - Revising ratings to update or correct their details.
 * - Fetching detailed rating entries and aggregated score data from the blockchain.
 * - Validating rating contents and signatures to ensure data integrity and authenticity.
 * - Encoding and decoding rating values and other data for blockchain compatibility.
 * - Generating unique URIs and message IDs for rating entries for identification and tracking.
 * - Handling digital signatures for secure transactions.
 *
 * Usage:
 * This module is primarily used by Rating Authors or Ledger/API Providers within the Cord Network ecosystem.
 * It enables these entities to manage rating data effectively, ensuring that the ratings are accurately represented
 * and securely stored on the blockchain. The module's functions are designed to be used in a variety of scenarios,
 * from creating new ratings and modifying existing ones to retrieving comprehensive rating information for analysis
 * and presentation purposes.
 *
 * Implementation:
 * The module comprises several internal functions that handle the various aspects of rating data management,
 * including validating content, encoding and decoding values, managing digital signatures, and interacting
 * with the Cord Network blockchain API. These functions are designed to work together seamlessly, providing
 * a robust and efficient toolset for rating management on the blockchain.
 *
 * The module's functionality is exposed through a set of exportable functions, which can be integrated into
 * broader applications within the Cord Network ecosystem or other blockchain-based systems that require
 * sophisticated rating management capabilities.
 */

import {
  IRatingContent,
  IRatingTransformed,
  IRatingEntry,
  EntityTypeOf,
  RatingTypeOf,
  DidUri,
  blake2AsHex,
  RATING_IDENT,
  RATING_PREFIX,
  IRatingDispatch,
  RatingEntryUri,
  SpaceUri,
  SignCallback,
  IRatingRevokeEntry,
  SignResponseData,
} from '@cord.network/types'
import type {
  AccountId,
  H256,
  Bytes,
  SpaceId,
  HexString,
  DidSignature,
} from '@cord.network/types'
import {
  isDidSignature,
  verifyDidSignature,
  resolveKey,
  signatureToJson,
  signatureFromJson,
} from '@cord.network/did'
import {
  hashToUri,
  isValidIdentifier,
  uriToIdentifier,
} from '@cord.network/identifier'
import { Crypto, SDKErrors, UUID } from '@cord.network/utils'
import { ConfigService } from '@cord.network/config'
import * as Did from '@cord.network/did'

/**
 * Validates the content of a rating entry.
 *
 * This function checks the integrity and correctness of a rating content object,
 * ensuring that all fields are filled, and that certain numeric and enum field values
 * are within acceptable ranges. It is designed to work with both IRatingContent and
 * IRatingTransformed objects.
 *
 * @param ratingContent - The rating content to validate.
 * @throws {RatingContentError} Throws an error if any field is empty, if total ratings exceed a certain limit,
 *                              or if 'entityType' or 'ratingType' values are invalid.
 *
 * @internal
 */
function validateRatingContent(
  ratingContent: IRatingContent | IRatingTransformed
): void {
  const allFieldsFilled = Object.entries(ratingContent).every(
    ([key, value]) => {
      if (value === undefined || value === null || value === '') {
        throw new SDKErrors.RatingContentError(
          `Field '${key}' cannot be empty.`
        )
      }
      return true
    }
  )

  if (!allFieldsFilled) {
    throw new SDKErrors.RatingContentError('All fields must be filled.')
  }

  if ('totalRating' in ratingContent) {
    if (ratingContent.totalRating > ratingContent.countOfTxn * 5) {
      throw new SDKErrors.RatingContentError(
        `Total rating cannot exceed ${ratingContent.countOfTxn * 5}.`
      )
    }
  } else if (ratingContent.totalEncodedRating > ratingContent.countOfTxn * 50) {
    throw new SDKErrors.RatingContentError(
      `Total encoded rating cannot exceed ${ratingContent.countOfTxn * 50}.`
    )
  }

  if (!Object.values(EntityTypeOf).includes(ratingContent.entityType)) {
    throw new SDKErrors.RatingContentError(
      `Invalid entityType: ${ratingContent.entityType}.`
    )
  }

  if (!Object.values(RatingTypeOf).includes(ratingContent.ratingType)) {
    throw new SDKErrors.RatingContentError(
      `Invalid ratingType: ${ratingContent.ratingType}.`
    )
  }
}

/**
 * Encodes a total rating value by multiplying it with a specified modulus.
 *
 * This function is used to encode a rating value, typically by scaling it up.
 * For example, if the rating system allows for decimal values, the function can be
 * used to convert these to an integer format by multiplying with 10 (or any other modulus).
 *
 * @param totalRating - The total rating value to encode.
 * @param [modulus=10] - The modulus to multiply the total rating by (defaults to 10).
 * @returns The encoded rating value.
 *
 * @internal
 */
function encodeRatingValue(totalRating: number, modulus = 10): number {
  return Math.round(totalRating * modulus)
}

/**
 * Verifies the signature of a given digest against a provided DID (Decentralized Identifier).
 *
 * This function is responsible for ensuring the integrity and authenticity of a signed digest.
 * It converts the hex string digest into a Uint8Array, extracts the necessary information from
 * the DID signature, and then verifies the signature using the provided DID URI. The function
 * uses a default or provided DID resolve key function to fetch the necessary public key for
 * verification.
 *
 * @param digest - The hex string representation of the digest to be verified.
 * @param signature - The digital signature object, which includes the signature data.
 * @param providerDid - The DID URI of the provider whose signature is to be verified.
 * @param [didResolveKey=resolveKey] - (Optional) A function to resolve the DID key. Defaults to 'resolveKey'.
 * @throws {Error} Throws an error if the signature verification fails or if the provided data is invalid.
 *
 * @internal
 */
export async function verifySignature(
  digest: HexString,
  signature: DidSignature,
  providerDid: DidUri,
  didResolveKey = resolveKey
): Promise<void> {
  isDidSignature(signature)

  const signingData = new Uint8Array([...Crypto.coToUInt8(digest)])

  await verifyDidSignature({
    ...signatureFromJson(signature),
    message: signingData,
    expectedSigner: providerDid,
    expectedVerificationMethod: 'assertionMethod',
    didResolveKey,
  })
}

/**
 * Generates common fields used in various transaction-related operations.
 *
 * This function creates a unique message ID (if not provided) and the current transaction time.
 * The message ID is either the provided `messageId` or a newly generated one using the `UUID.generate()` method.
 * The transaction time is the current time in ISO 8601 format.
 *
 * @param [messageId] - An optional message ID. If not provided, a new one is generated.
 * @returns An object containing the message ID (`msgId`) and the transaction time (`transactionTime`).
 *
 * @internal
 */
function generateCommonFields(messageId?: string): {
  msgId: string
  transactionTime: string
} {
  const msgId = messageId || `msg-${UUID.generate()}`
  const transactionTime = new Date().toISOString()
  return { msgId, transactionTime }
}

/**
 * Hashes and signs a given entry object.
 *
 * This function takes any entry object, computes its hash, and then uses the provided callback
 * to sign the hash. The hash is computed as a hexadecimal string, and the signing is done based
 * on the DID URI of the provider.
 *
 * @param entry - The entry object to be hashed and signed.
 * @param provider - The DID URI of the provider who will sign the hash.
 * @param signCallback - A callback function for handling the signing operation.
 * @returns A promise that resolves to an object containing the entry digest and the provider signature.
 *
 * @internal
 */
async function hashAndSign(
  entry: any,
  provider: DidUri,
  signCallback: SignCallback
) {
  const entryDigest = Crypto.hashObjectAsHexStr(entry)
  const uint8Hash = new Uint8Array([...Crypto.coToUInt8(entryDigest)])
  const providerSignature = await signCallback({
    data: uint8Hash,
    did: provider,
    keyRelationship: 'assertionMethod',
  })
  return { entryDigest, providerSignature }
}

/**
 * Computes a signature for a given digest.
 *
 * This function converts the provided digest into a Uint8Array, then calls the provided
 * `signCallback` to generate a digital signature. The signature is associated with the DID
 * URI of the author.
 *
 * @param digest - The hex string representation of the digest to be signed.
 * @param author - The DID URI of the author who will sign the digest.
 * @param signCallback - A callback function for handling the signing operation.
 * @returns A promise that resolves to the digital signature of the author.
 *
 * @internal
 */
async function digestSignature(
  digest: HexString,
  author: DidUri,
  signCallback: SignCallback
) {
  const uint8Hash = new Uint8Array([...Crypto.coToUInt8(digest)])
  const authorSignature = await signCallback({
    data: uint8Hash,
    did: author,
    keyRelationship: 'assertionMethod',
  })
  return authorSignature
}

/**
 * Generates a unique URI for a rating entry based on various input parameters.
 *
 * This function takes the digest of a rating entry, along with other identifying information,
 * and generates a unique URI for that entry. It involves several steps: encoding input parameters
 * into SCALE (Simple Concatenated Aggregate Little-Endian) format, combining these encoded values,
 * hashing the combined result, and then formatting it as a URI.
 *
 * @param entryDigest - The hex string representation of the rating entry's digest.
 * @param entityUid - The unique identifier of the entity associated with the rating entry.
 * @param entryMsgId - The message ID associated with the rating entry.
 * @param chainSpace - The identifier of the chain space where the rating is stored.
 * @param providerUri - The DID URI of the provider associated with the rating entry.
 * @returns A promise that resolves to the unique URI of the rating entry.
 *
 * @throws {Error} Throws an error if there's an issue with generating the URI.
 *
 * @internal
 */
export async function getUriForRatingEntry(
  entryDigest: HexString,
  entityUid: string,
  entryMsgId: string,
  chainSpace: SpaceId,
  providerUri: DidUri
): Promise<RatingEntryUri> {
  const api = ConfigService.get('api')
  const scaleEncodedRatingEntryDigest = api
    .createType<H256>('H256', entryDigest)
    .toU8a()
  const scaleEncodedEntityUid = api
    .createType<Bytes>('Bytes', entityUid)
    .toU8a()
  const scaleEncodedMessageId = api
    .createType<Bytes>('Bytes', entryMsgId)
    .toU8a()
  const scaleEncodedChainSpace = api
    .createType<Bytes>('Bytes', uriToIdentifier(chainSpace))
    .toU8a()
  const scaleEncodedProvider = api
    .createType<AccountId>('AccountId', Did.toChain(providerUri))
    .toU8a()
  const digest = blake2AsHex(
    Uint8Array.from([
      ...scaleEncodedRatingEntryDigest,
      ...scaleEncodedEntityUid,
      ...scaleEncodedMessageId,
      ...scaleEncodedChainSpace,
      ...scaleEncodedProvider,
    ])
  )
  return hashToUri(digest, RATING_IDENT, RATING_PREFIX) as RatingEntryUri
}

/**
 * Builds a rating entry from the provided content properties.
 *
 * This function takes an IRatingContent object and additional information
 * such as the provider's DID URI and a callback function for signing, and
 * constructs a transformed IRatingEntry object. This object includes an encoded
 * rating value and a signature. If the entry contains a reference ID, it is validated
 * and transformed into a proper identifier.
 *
 * This function is used by Rating providers.
 *
 * @param entry - The rating content to be transformed.
 * @param provider - The DID URI of the provider.
 * @param signCallback - A callback function to handle the signing process.
 * @param [messageId] - An optional message ID. If not provided, one is generated.
 * @returns A promise that resolves to the transformed rating entry.
 *
 * @example
 * const ratingContent: IRatingContent = {
 *   entityUid: '12345',
 *   entityId: '67890',
 *   providerUid: 'abcde',
 *   providerId: 'fghij',
 *   countOfTxn: 100,
 *   totalRating: 4.5,
 *   // ... other properties ...
 * };
 *
 * const providerDid = 'did:example:123';
 * const signCallback = async (data) => {
 *   // ... signing logic ...
 * };
 *
 * buildFromContentProperties(ratingContent, providerDid, signCallback)
 *   .then(ratingEntry => {
 *     console.log(ratingEntry);
 *   })
 *   .catch(error => {
 *     console.error('Error building rating entry:', error);
 *   });
 *
 * @throws {RatingContentError} Throws an error if the transformation process fails.
 */
export async function buildFromContentProperties(
  entry: IRatingContent,
  provider: DidUri,
  signCallback: SignCallback,
  messageId?: string
): Promise<IRatingEntry> {
  try {
    validateRatingContent(entry)

    const { msgId, transactionTime } = generateCommonFields(messageId)
    const { totalRating, ...restOfEntry } = entry

    const entryTransform: IRatingTransformed = {
      ...restOfEntry,
      ...(entry.referenceId !== undefined && {
        referenceId: entry.referenceId,
      }),
      providerDid: Did.toChain(provider),
      totalEncodedRating: encodeRatingValue(totalRating),
    }
    if (entry.referenceId) {
      const [isValid, error] = isValidIdentifier(entry.referenceId)
      if (!isValid) {
        throw new SDKErrors.InvalidIdentifierError(
          error || `Invalid identifier: ${entry.referenceId}`
        )
      }
      entryTransform.referenceId = uriToIdentifier(entry.referenceId)
    }

    const { entryDigest, providerSignature } = await hashAndSign(
      { entryTransform, msgId, transactionTime },
      provider,
      signCallback
    )

    const transformedEntry: IRatingEntry = {
      entry: entryTransform,
      messageId: msgId,
      entryDigest,
      providerSignature: signatureToJson(providerSignature),
    }

    return transformedEntry
  } catch (error) {
    throw new SDKErrors.RatingContentError(
      `Rating content transformation error: "${error}".`
    )
  }
}

/**
 * Constructs a rating revoke entry from the provided parameters.
 *
 * This function creates a rating revoke entry, which includes a message ID,
 * a reference rating URI, an entry digest, and a provider's digital signature.
 * It is used to revoke a previously created rating entry.
 *
 * This function is used by Rating providers.
 *
 * @param entryUri - The URI of the rating entry to be revoked.
 * @param entityUid - The unique identifier of the entity associated with the rating entry.
 * @param provider - The DID URI of the provider responsible for the revocation.
 * @param signCallback - A callback function for signing the revocation entry.
 * @param [messageId] - An optional message ID. If not provided, one is generated.
 * @returns A promise that resolves to the constructed rating revoke entry.
 *
 * @example
 * const entryUri = 'rating:cord:example';
 * const entityUid = 'entity-123';
 * const providerDid = 'did:example:provider';
 * const signCallback = async (data) => {
 *   // ... signing logic ...
 * };
 *
 * buildFromRevokeProperties(entryUri, entityUid, providerDid, signCallback)
 *   .then(revokeEntry => {
 *     console.log(revokeEntry);
 *   })
 *   .catch(error => {
 *     console.error('Error building revoke entry:', error);
 *   });
 *
 * @throws {RatingContentError} Throws an error if the revocation entry construction process fails.
 */
export async function buildFromRevokeProperties(
  entryUri: RatingEntryUri,
  entityUid: string,
  provider: DidUri,
  signCallback: SignCallback,
  messageId?: string
): Promise<IRatingRevokeEntry> {
  try {
    const { msgId, transactionTime } = generateCommonFields(messageId)
    const entryTransform = { entryUri, msgId, provider, transactionTime }

    const { entryDigest, providerSignature } = await hashAndSign(
      entryTransform,
      provider,
      signCallback
    )

    const transformedEntry: IRatingRevokeEntry = {
      entry: {
        messageId: msgId,
        entryDigest,
        referenceId: entryUri,
        providerSignature: signatureToJson(providerSignature),
      },
      entityUid,
      providerDid: provider,
    }

    return transformedEntry
  } catch (error) {
    throw new SDKErrors.RatingContentError(
      `Rating content transformation error: "${error}".`
    )
  }
}

/**
 * Validates that none of the provided fields are empty.
 *
 * This utility function checks if any field in the given array is null, undefined, or an empty string.
 * If any such field is found, it throws an error indicating that required fields cannot be empty.
 *
 * @param fields - An array of fields to be validated.
 * @throws {RatingPropertiesError} If any field is empty (null, undefined, or empty string).
 *
 * @internal
 */
function validateRequiredFields(fields: any[]): void {
  const isFieldEmpty = (field: any): boolean => {
    return field === null || field === undefined || field === ''
  }

  if (fields.some(isFieldEmpty)) {
    throw new SDKErrors.RatingPropertiesError(
      'Required fields cannot be empty.'
    )
  }
}

/**
 * Validates that a given string is a valid hexadecimal format.
 *
 * This function checks if the provided string matches the pattern of a hexadecimal string (prefixed with '0x').
 * If the string does not match the expected format, it throws an error.
 *
 * @param entryDigest - The string to be validated as a HexString.
 * @throws {RatingPropertiesError} If the string is not in a valid hexadecimal format.
 *
 * @internal
 */
function validateHexString(entryDigest: string): void {
  if (!/^0x[0-9a-fA-F]+$/.test(entryDigest)) {
    throw new SDKErrors.RatingPropertiesError(
      'Invalid HexString for entryDigest.'
    )
  }
}

/**
 * Creates a rating object with a unique rating URI and common details.
 *
 * This function generates a unique URI for a rating entry using several key pieces of information.
 * It also constructs an object containing common details of the rating entry, including the
 * generated URI, chain space, message ID, entry digest, author's URI, and the author's digital signature.
 *
 * @param entryDigest - The hex string representation of the rating entry's digest.
 * @param entityUid - The unique identifier of the entity associated with the rating entry.
 * @param messageId - The message ID associated with the rating entry.
 * @param chainSpace - The identifier of the chain space where the rating is stored.
 * @param providerUri - The DID URI of the provider associated with the rating entry.
 * @param authorUri - The DID URI of the author who signed the rating entry.
 * @param authorSig - The digital signature of the author.
 * @returns A promise that resolves to an object containing the rating entry URI and its details.
 *
 * @internal
 */
async function createRatingObject(
  entryDigest: HexString,
  entityUid: string,
  messageId: string,
  chainSpace: SpaceUri,
  providerUri: DidUri,
  authorUri: DidUri,
  authorSig: SignResponseData
): Promise<{ uri: RatingEntryUri; details: any }> {
  const ratingUri = await getUriForRatingEntry(
    entryDigest,
    entityUid,
    messageId,
    chainSpace,
    providerUri
  )

  const authorSignature = signatureToJson(authorSig)

  return {
    uri: ratingUri,
    details: {
      entryUri: ratingUri,
      chainSpace,
      messageId,
      entryDigest,
      authorUri,
      authorSignature,
    },
  }
}

/**
 * Constructs a rating entry for dispatch to a blockchain, complete with validation and digital signature.
 *
 * This function is responsible for taking a raw rating entry, validating its content, and ensuring it is correctly signed.
 * It generates a unique URI for the rating, which encapsulates its identity on the blockchain.
 * The function is primarily used by Rating Authors or Ledger/API Providers to ensure that the ratings
 * they produce are valid, signed, and ready for dispatch to the specified blockchain space.
 *
 * @param rating - The raw rating entry that needs to be processed.
 *                                It should include all necessary details like entityUid, messageId, entryDigest, and providerSignature.
 * @param chainSpace - Identifier for the blockchain space where the rating will be stored.
 *                                This helps in routing the rating to the correct blockchain environment.
 * @param authorUri - The Decentralized Identifier (DID) URI of the author.
 *                             This is used for signing the rating and linking it to its author.
 * @param signCallback - A callback function that will be used for signing the rating.
 *                                      This function should adhere to the necessary cryptographic standards for signature generation.
 *
 * @returns - A promise that resolves to an object containing:
 *    - `uri`: A unique URI representing the rating entry on the blockchain.
 *    - `details`: An object containing the processed rating entry details ready for dispatch.
 *
 * @throws {SDKErrors.RatingPropertiesError} - Thrown if there's an issue with the rating's content, signature, or any required fields.
 *
 * @example
 * // Example of a rating entry object
 * const ratingEntry = {
 *   entry: {
 *     entityUid: 'entity123',
 *     // ... other rating entry properties ...
 *   },
 *   messageId: 'msg-123',
 *   entryDigest: '0xabcdef12345',
 *   providerSignature: {
 *     // ... signature data ...
 *   },
 *   // ... other rating entry properties ...
 * };
 *
 * // Usage
 * const chainSpace = 'chainSpace123';
 * const authorUri = 'did:example:author123';
 *
 * try {
 *   const result = await buildFromRatingProperties(ratingEntry, chainSpace, authorUri, signCallback);
 *   console.log('Rating entry URI:', result.uri);
 *   console.log('Rating entry details:', result.details);
 * } catch (error) {
 *   console.error('Error building rating entry:', error);
 * }
 */
export async function buildFromRatingProperties(
  rating: IRatingEntry,
  chainSpace: SpaceUri,
  authorUri: DidUri,
  signCallback: SignCallback
): Promise<{ uri: RatingEntryUri; details: IRatingDispatch }> {
  try {
    validateRatingContent(rating.entry)
    verifySignature(
      rating.entryDigest,
      rating.providerSignature,
      Did.getDidUri(rating.entry.providerDid)
    )

    validateRequiredFields([
      chainSpace,
      authorUri,
      rating.messageId,
      rating.entryDigest,
    ])
    validateHexString(rating.entryDigest)

    const authorSignature = await digestSignature(
      rating.entryDigest,
      authorUri,
      signCallback
    )

    const { uri, details } = await createRatingObject(
      rating.entryDigest,
      rating.entry.entityUid,
      rating.messageId,
      chainSpace,
      Did.getDidUri(rating.entry.providerDid),
      authorUri,
      authorSignature
    )

    const { providerId, entityId, ...chainEntry } = rating.entry

    details.entry = chainEntry

    return { uri, details }
  } catch (error) {
    throw new SDKErrors.RatingPropertiesError(
      `Rating content transformation error: "${error}".`
    )
  }
}

/**
 * Constructs a revocation entry for a previously submitted rating on the blockchain.
 *
 * This function handles the process of revoking a rating. It takes a rating revocation entry,
 * verifies the signature of the original rating, validates required fields, and generates the necessary
 * signatures for the revocation entry. This is essential for maintaining the integrity and trustworthiness
 * of the rating system, especially in decentralized environments.
 *
 * This function is specifically designed for use by Rating Authors or Ledger/API Providers.
 *
 * @param rating - The rating revoke entry to process.
 *                                      This includes the original rating's digest, signature, and other relevant details.
 * @param chainSpace - The identifier of the blockchain space (as a URI) where the rating is being revoked.
 *                                This helps in pinpointing the exact location on the blockchain where the rating resides.
 * @param authorUri - The Decentralized Identifier (DID) URI of the author who is revoking the rating.
 *                             This identifier is crucial for associating the revocation with the correct author.
 * @param signCallback - A callback function that handles the signing of the revocation entry.
 *                                      The signature ensures the authenticity and integrity of the revocation request.
 *
 * @returns - A promise that resolves to an object containing:
 *    - `uri`: A unique URI for the revocation entry on the blockchain.
 *    - `details`: An object with the details of the revocation, ready for dispatch to the blockchain.
 *
 * @throws {SDKErrors.RatingPropertiesError} - Thrown if there is an issue with the revocation's content,
 *                                             such as invalid fields or signature verification failure.
 *
 * @example
 * // Example usage of the function
 * const ratingRevokeEntry = {
 *   // ... rating revoke entry properties ...
 * };
 * const chainSpace = 'chainSpace123';
 * const authorUri = 'did:example:author123';
 *
 * try {
 *   const result = await buildFromRevokeRatingProperties(ratingRevokeEntry, chainSpace, authorUri, signCallback);
 *   console.log('Revocation entry URI:', result.uri);
 *   console.log('Revocation entry details:', result.details);
 * } catch (error) {
 *   console.error('Error building revocation entry:', error);
 * }
 */
export async function buildFromRevokeRatingProperties(
  rating: IRatingRevokeEntry,
  chainSpace: SpaceUri,
  authorUri: DidUri,
  signCallback: SignCallback
): Promise<{ uri: RatingEntryUri; details: IRatingDispatch }> {
  try {
    verifySignature(
      rating.entry.entryDigest,
      rating.entry.providerSignature,
      Did.getDidUri(rating.providerDid)
    )

    validateRequiredFields([
      chainSpace,
      authorUri,
      rating.entry.messageId,
      rating.entry.entryDigest,
    ])
    validateHexString(rating.entry.entryDigest)

    const authorSignature = await digestSignature(
      rating.entry.entryDigest,
      authorUri,
      signCallback
    )

    const { uri, details } = await createRatingObject(
      rating.entry.entryDigest,
      rating.entityUid,
      rating.entry.messageId,
      chainSpace,
      Did.getDidUri(rating.providerDid),
      authorUri,
      authorSignature
    )

    details.entry = rating.entry

    return { uri, details }
  } catch (error) {
    throw new SDKErrors.RatingPropertiesError(
      `Rating content transformation error: "${error}".`
    )
  }
}
