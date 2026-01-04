module Spago.Db
  ( ConnectOptions
  , Db
  , PackageSet
  , PackageSetEntry
  , PackageVersion
  , connect
  , getLastPull
  , getManifest
  , getMetadata
  , getMetadataForPackages
  , insertManifest
  , insertMetadata
  , insertPackageSet
  , insertPackageSetEntry
  , packageSetCodec
  , selectLatestPackageSetByCompiler
  , selectPackageSets
  , updateLastPull
  ) where

import Spago.Prelude

import Control.Promise (Promise)
import Control.Promise as Promise
import Data.Array as Array
import Data.Codec.JSON as CJ
import Data.Codec.JSON.Record as CJ.Record
import Data.DateTime (Date, DateTime(..))
import Data.DateTime as DateTime
import Data.Either as Either
import Data.Filterable (filterMap)
import Data.Formatter.DateTime as DateTime.Format
import Data.Map as Map
import Data.Nullable (Nullable)
import Data.Nullable as Nullable
import Data.Time.Duration (Minutes(..))
import Effect.Now as Now
import Effect.Uncurried (EffectFn1, EffectFn2, EffectFn3, EffectFn4)
import Effect.Uncurried as Uncurried
import Registry.Internal.Codec as Internal.Codec
import Registry.Internal.Format as Internal.Format
import Registry.Manifest as Manifest
import Registry.Metadata as Metadata
import Registry.PackageName as PackageName
import Registry.Version as Version

--------------------------------------------------------------------------------
-- API

type ConnectOptions =
  { database :: GlobalPath
  , logger :: String -> Effect Unit
  }

connect :: ConnectOptions -> Aff Db
connect { database, logger } =
  Promise.toAffE $ Uncurried.runEffectFn2 connectImpl database (Uncurried.mkEffectFn1 logger)

insertPackageSet :: Db -> PackageSet -> Aff Unit
insertPackageSet db = Promise.toAffE <<< Uncurried.runEffectFn2 insertPackageSetImpl db <<< packageSetToJs

insertPackageSetEntry :: Db -> PackageSetEntry -> Aff Unit
insertPackageSetEntry db = Promise.toAffE <<< Uncurried.runEffectFn2 insertPackageSetEntryImpl db <<< packageSetEntryToJs

selectPackageSets :: Db -> Aff (Array PackageSet)
selectPackageSets db = do
  packageSets <- Promise.toAffE $ Uncurried.runEffectFn1 selectPackageSetsImpl db
  pure $ Array.mapMaybe packageSetFromJs packageSets

selectLatestPackageSetByCompiler :: Db -> Version -> Aff (Maybe PackageSet)
selectLatestPackageSetByCompiler db compiler = do
  maybePackageSet <- Nullable.toMaybe <$> Promise.toAffE (Uncurried.runEffectFn2 selectLatestPackageSetByCompilerImpl db (Version.print compiler))
  pure $ packageSetFromJs =<< maybePackageSet

{-

We'll need these when implementing a command for "show me what's in this package set"

selectPackageSetEntriesBySet :: Db -> Version -> Effect (Array PackageSetEntry)
selectPackageSetEntriesBySet db packageSetVersion = do
  packageSetEntries <- Uncurried.runEffectFn2 selectPackageSetEntriesBySetImpl db (Version.print packageSetVersion)
  pure $ Array.mapMaybe packageSetEntryFromJs packageSetEntries

selectPackageSetEntriesByPackage :: Db -> PackageName -> Version -> Effect (Array PackageSetEntry)
selectPackageSetEntriesByPackage db packageName version = do
  packageSetEntries <- Uncurried.runEffectFn3 selectPackageSetEntriesByPackageImpl db (PackageName.print packageName) (Version.print version)
  pure $ Array.mapMaybe packageSetEntryFromJs packageSetEntries
-}

getLastPull :: Db -> String -> Aff (Maybe DateTime)
getLastPull db key = do
  maybePull <- Nullable.toMaybe <$> Promise.toAffE (Uncurried.runEffectFn2 getLastPullImpl db key)
  pure $ (Either.hush <<< DateTime.Format.unformat Internal.Format.iso8601DateTime) =<< maybePull

updateLastPull :: Db -> String -> DateTime -> Aff Unit
updateLastPull db key date = Promise.toAffE $ Uncurried.runEffectFn3 updateLastPullImpl db key (DateTime.Format.format Internal.Format.iso8601DateTime date)

getManifest :: Db -> PackageName -> Version -> Aff (Maybe Manifest)
getManifest db packageName version = do
  maybeManifest <- Nullable.toMaybe <$> Promise.toAffE (Uncurried.runEffectFn3 getManifestImpl db (PackageName.print packageName) (Version.print version))
  pure $ (Either.hush <<< parseJson Manifest.codec) =<< maybeManifest

insertManifest :: Db -> PackageName -> Version -> Manifest -> Aff Unit
insertManifest db packageName version manifest = Promise.toAffE $ Uncurried.runEffectFn4 insertManifestImpl db (PackageName.print packageName) (Version.print version) (printJson Manifest.codec manifest)

getMetadata :: Db -> PackageName -> Aff (Maybe Metadata)
getMetadata db packageName =
  getMetadataForPackages db [ packageName ]
    <#> Map.lookup packageName

getMetadataForPackages :: Db -> Array PackageName -> Aff (Map PackageName Metadata)
getMetadataForPackages db packageNames = do
  metadataEntries <- Promise.toAffE $ Uncurried.runEffectFn2 getMetadataForPackagesImpl db (PackageName.print <$> packageNames)
  now <- liftEffect Now.nowDateTime
  pure
    $ metadataEntries
    #
      ( filterMap \metadataEntry -> do
          packageName <- hush $ PackageName.parse metadataEntry.name
          lastFetched <- Either.hush $ DateTime.Format.unformat Internal.Format.iso8601DateTime metadataEntry.last_fetched
          -- if the metadata is older than 15 minutes, we consider it stale
          case DateTime.diff now lastFetched of
            Minutes n | n <= 15.0 -> do
              metadata <- Either.hush $ parseJson Metadata.codec metadataEntry.metadata
              pure $ packageName /\ metadata
            _ -> Nothing
      )
    # Map.fromFoldable

insertMetadata :: Db -> PackageName -> Metadata -> Aff Unit
insertMetadata db packageName metadata@(Metadata { unpublished }) = do
  now <- liftEffect Now.nowDateTime
  Promise.toAffE $ Uncurried.runEffectFn4 insertMetadataImpl db (PackageName.print packageName) (printJson Metadata.codec metadata) (DateTime.Format.format Internal.Format.iso8601DateTime now)
  -- we also do a pass of removing the cached manifests that have been unpublished
  for_ (Map.toUnfoldable unpublished :: Array _) \(Tuple version _) -> do
    Promise.toAffE $ Uncurried.runEffectFn3 removeManifestImpl db (PackageName.print packageName) (Version.print version)

--------------------------------------------------------------------------------
-- Table types and conversions

-- Note: bump `Path.databaseVersion` every time we change the database schema in a breaking way
data Db

type PackageSetJs =
  { version :: String
  , compiler :: String
  , date :: String
  }

type PackageSet =
  { version :: Version
  , compiler :: Version
  , date :: Date
  }

type PackageVersionJs =
  { name :: String
  , version :: String
  , published :: Int
  , date :: String
  , manifest :: String
  , location :: String
  }

type PackageVersion =
  { name :: PackageName
  , version :: Version
  , published :: Boolean
  , date :: DateTime
  , manifest :: Manifest
  , location :: Location
  }

type PackageSetEntryJs =
  { packageSetVersion :: String
  , packageName :: String
  , packageVersion :: String
  }

type PackageSetEntry =
  { packageSetVersion :: Version
  , packageName :: PackageName
  , packageVersion :: Version
  }

type MetadataEntryJs =
  { name :: String
  , metadata :: String
  , last_fetched :: String
  }

packageSetToJs :: PackageSet -> PackageSetJs
packageSetToJs { version, compiler, date } =
  { version: Version.print version
  , compiler: Version.print compiler
  , date: DateTime.Format.format Internal.Format.iso8601Date $ DateTime date bottom
  }

packageSetFromJs :: PackageSetJs -> Maybe PackageSet
packageSetFromJs p = hush do
  version <- Version.parse p.version
  compiler <- Version.parse p.compiler
  date <- map DateTime.date $ DateTime.Format.unformat Internal.Format.iso8601Date p.date
  pure $ { version, compiler, date }

packageSetEntryToJs :: PackageSetEntry -> PackageSetEntryJs
packageSetEntryToJs { packageSetVersion, packageName, packageVersion } =
  { packageSetVersion: Version.print packageSetVersion
  , packageName: PackageName.print packageName
  , packageVersion: Version.print packageVersion
  }

{-

packageSetEntryFromJs :: PackageSetEntryJs -> Maybe PackageSetEntry
packageSetEntryFromJs p = hush do
  packageSetVersion <- Version.parse p.packageSetVersion
  packageName <- PackageName.parse p.packageName
  packageVersion <- Version.parse p.packageVersion
  pure $ { packageSetVersion, packageName, packageVersion }

-}

--------------------------------------------------------------------------------
-- Codecs

packageSetCodec :: CJ.Codec PackageSet
packageSetCodec = CJ.named "PackageSet" $ CJ.Record.object
  { date: Internal.Codec.iso8601Date
  , version: Version.codec
  , compiler: Version.codec
  }

--------------------------------------------------------------------------------
-- FFI

foreign import connectImpl :: EffectFn2 GlobalPath (EffectFn1 String Unit) (Promise Db)

foreign import insertPackageSetImpl :: EffectFn2 Db PackageSetJs (Promise Unit)

foreign import insertPackageSetEntryImpl :: EffectFn2 Db PackageSetEntryJs (Promise Unit)

foreign import selectLatestPackageSetByCompilerImpl :: EffectFn2 Db String (Promise (Nullable PackageSetJs))

foreign import selectPackageSetsImpl :: EffectFn1 Db (Promise (Array PackageSetJs))

foreign import selectPackageSetEntriesBySetImpl :: EffectFn2 Db String (Promise (Array PackageSetEntryJs))

foreign import selectPackageSetEntriesByPackageImpl :: EffectFn3 Db String String (Promise (Array PackageSetEntryJs))

foreign import getLastPullImpl :: EffectFn2 Db String (Promise (Nullable String))

foreign import updateLastPullImpl :: EffectFn3 Db String String (Promise Unit)

foreign import getManifestImpl :: EffectFn3 Db String String (Promise (Nullable String))

foreign import insertManifestImpl :: EffectFn4 Db String String String (Promise Unit)

foreign import removeManifestImpl :: EffectFn3 Db String String (Promise Unit)

foreign import getMetadataImpl :: EffectFn2 Db String (Promise (Nullable MetadataEntryJs))

foreign import getMetadataForPackagesImpl :: EffectFn2 Db (Array String) (Promise (Array MetadataEntryJs))

foreign import insertMetadataImpl :: EffectFn4 Db String String String (Promise Unit)
