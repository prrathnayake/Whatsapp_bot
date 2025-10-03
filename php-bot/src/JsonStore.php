<?php

namespace App;

class JsonStore
{
    public static function load(string $path, $default)
    {
        if (!file_exists($path)) {
            return $default;
        }

        $contents = file_get_contents($path);
        if ($contents === false || $contents === '') {
            return $default;
        }

        $data = json_decode($contents, true);
        return $data === null ? $default : $data;
    }

    public static function save(string $path, $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }

        file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    }
}
